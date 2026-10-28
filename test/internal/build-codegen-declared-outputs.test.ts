/**
 * The bindgen step in scripts/build/codegen.ts has to declare every file its
 * script writes, the Generated*.h headers included, not only the .cpp files
 * that get compiled.
 *
 * Compiles only order-depend on codegen; the compiler's depfile is what rebuilds
 * a TU when a generated header changes, and within one build ninja re-checks a
 * depfile entry after the step that writes it only if the entry is a declared
 * output of that step. A header no edge declares is stat'd once at startup, so
 * a TU including one (BunObject.cpp includes GeneratedBunObject.h) was
 * recompiled by the build AFTER the one that regenerated the header, and the
 * first build linked the stale object against the fresh generated code.
 *
 * The step is checked twice: what its emitter declares, and what its script
 * writes when run for real into a scratch dir.
 */
import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, bunRun, isWindows, tempDir } from "harness";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { emitBindgen, registerCodegenRules, type CodegenOutputs } from "../../scripts/build/codegen.ts";
import { registerDirStamps } from "../../scripts/build/compile.ts";
import { resolveConfig, type Config, type Toolchain } from "../../scripts/build/config.ts";
import { Ninja, readManifest } from "../../scripts/build/ninja.ts";
import { quote } from "../../scripts/build/shell.ts";
import type { Sources } from "../../scripts/glob-sources.ts";

/** A fully-populated fake toolchain. */
function mockToolchain(): Toolchain {
  return {
    cc: "/fake/llvm/bin/clang",
    cxx: "/fake/llvm/bin/clang++",
    hostCc: undefined,
    hostCxx: undefined,
    clangVersion: "23.1.1",
    clangResourceDir: "/fake/llvm/lib/clang/23",
    ar: "/fake/llvm/bin/llvm-ar",
    ld: "/fake/llvm/bin/ld.lld",
    ld64Lld: "/fake/llvm/bin/ld64.lld",
    rustLlvmVersion: "23.1.1",
    rustSysroot: undefined,
    rustHostTriple: undefined,
    strip: "/fake/bin/strip",
    llvmStrip: "/fake/llvm/bin/llvm-strip",
    nm: "/fake/llvm/bin/llvm-nm",
    readobj: "/fake/llvm/bin/llvm-readobj",
    objdump: "/fake/llvm/bin/llvm-objdump",
    cxxfilt: "/fake/llvm/bin/llvm-cxxfilt",
    dsymutil: "/fake/llvm/bin/dsymutil",
    bun: bunExe(),
    // A shell command prefix, quoted like the one configure makes.
    jsRuntime: quote(bunExe(), process.platform === "win32"),
    esbuild: "/fake/bin/esbuild",
    ccache: undefined,
    cmake: "/fake/bin/cmake",
    cargo: undefined,
    cargoHome: undefined,
    rustupHome: undefined,
    msvcLinker: undefined,
    rc: undefined,
    nasm: undefined,
  };
}

interface Configured {
  cfg: Config;
  n: Ninja;
  o: CodegenOutputs;
  dirStamp: string;
}

/**
 * A linux-x64 debug target in `buildDir` (resolves on every host once told where
 * its sysroot is; the path is only recorded), with the rules the codegen
 * emitters reference registered and the empty output groups emitCodegen hands
 * them. Nothing is written to `buildDir`.
 */
function configure(buildDir: string): Configured {
  const cfg = resolveConfig(
    { os: "linux", arch: "x64", abi: "gnu", buildType: "Debug", buildDir, linuxSysroot: buildDir },
    mockToolchain(),
  );
  const n = new Ninja({ buildDir });
  registerDirStamps(n, cfg);
  registerCodegenRules(n, cfg);
  const o: CodegenOutputs = {
    all: [],
    generatedTypes: [],
    rustInputs: [],
    cppSources: [],
    cppHeaders: [],
    cppAll: [],
    builtinTableSources: [],
    internalModulesAsm: resolve(cfg.codegenDir, "InternalModuleRegistryConstants.S"),
    internalModulesBin: resolve(cfg.codegenDir, "InternalModuleRegistryConstants.bin"),
    bundledNamesOfModules: resolve(cfg.codegenDir, "bundled_names_of_modules.txt"),
    bundledHelpers: resolve(cfg.codegenDir, "runtime.out.js"),
    rootInstall: resolve(buildDir, "stamps", "install.stamp"),
  };
  return { cfg, n, o, dirStamp: resolve(cfg.codegenDir, ".dir") };
}

/** Just the lists the emitter under test reads; it never looks at the rest of `Sources`. */
function sourceLists(lists: Partial<Sources>): Sources {
  return lists as Sources;
}

/**
 * The outputs of the `build` line in `n` that produces `output`, spelled as in
 * build.ninja (buildDir-relative where possible), sorted. Ninja.build() also
 * declares relative outputs under their absolute paths for depfiles. An output
 * on another Windows drive is already absolute and needs no alias.
 */
function edgeOutputs(n: Ninja, output: string): string[] {
  const edge = readManifest(n.toString()).edges.find(edge => edge.outputs.includes(n.rel(output)));
  if (edge === undefined) throw new Error(`no build edge produces ${output}`);
  const relative = edge.outputs.filter(path => !isAbsolute(path));
  expect(edge.implicitOutputs.sort()).toEqual(relative.map(path => resolve(n.buildDir, path)).sort());
  return edge.outputs.sort();
}

/** `names` in the codegen dir, spelled as in build.ninja, sorted. */
function inCodegenDir({ cfg, n }: Configured, names: string[]): string[] {
  return names.map(name => n.rel(resolve(cfg.codegenDir, name))).sort();
}

/** `paths` normalized, sorted. */
function normalized(paths: string[]): string[] {
  return paths.map(p => resolve(p)).sort();
}

/**
 * Every .bind.ts under src/: the pattern glob-sources.ts expands for
 * emitBindgen (through node:fs globSync, which is too slow under a debug
 * build to run its whole pattern set here).
 */
function repoBindFiles(cfg: Config): string[] {
  return Array.from(new Bun.Glob("src/**/*.bind.ts").scanSync({ cwd: cfg.cwd }), p => resolve(cfg.cwd, p)).sort();
}

// The tests below that run a generator script run it under the build being
// tested; a debug build takes a few seconds to load one, more than the 5s
// default allows for.
const generatorTimeout = 60_000;

describe("emitBindgen", () => {
  test
    .skipIf(!isWindows)
    .concurrent("passes source paths through cmd from a long checkout containing spaces", async () => {
      const checkoutName = "checkout with spaces " + "long-".repeat(12);
      using dir = tempDir("build-codegen-command", {
        [checkoutName]: {
          "Cargo.toml": '[package]\nname = "bun"\nversion = "0.0.0"\n',
          src: {
            codegen: {
              "bindgen.ts": `
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const args = Object.fromEntries(process.argv.slice(2).map(arg => {
  const at = arg.indexOf("=");
  return [arg.slice(2, at), arg.slice(at + 1)];
}));
const sources = args.sources.split(",").map(pair => {
  const path = pair.slice(pair.indexOf("=") + 1);
  return { path: resolve(path), text: readFileSync(path, "utf8") };
});
mkdirSync(args["codegen-path"], { recursive: true });
writeFileSync(join(args["codegen-path"], "arguments.json"), JSON.stringify({ cwd: process.cwd(), sources, types: args["types-path"] }));
`,
            },
          },
        },
      });
      const c = configure(resolve(String(dir), "generated files"));
      const checkout = resolve(String(dir), checkoutName);
      const cfg = { ...c.cfg, cwd: checkout, typesDir: resolve(String(dir), "types with spaces") };
      const names = [
        ...repoBindFiles(c.cfg).map(path => relative(c.cfg.cwd, path)),
        "src/runtime/schema with spaces.bind.ts",
      ];
      const bindgen = names.map(name => resolve(checkout, name));
      expect(bindgen.reduce((length, path) => length + path.length, 0)).toBeGreaterThan(8191);
      for (let i = 0; i < bindgen.length; i++) {
        mkdirSync(dirname(bindgen[i]!), { recursive: true });
        writeFileSync(bindgen[i]!, `// ${names[i]}`);
      }
      emitBindgen({ ...c, cfg, sources: sourceLists({ bindgen, bindgenCodegen: [] }) });
      const manifest = c.n.toString();
      const edge = readManifest(manifest).edges.find(edge => edge.rule === "codegen")!;
      const recipe = /^rule codegen\n  command = (.*)$/m.exec(manifest.replace(/ \$\n +/g, " "))![1];
      const command = recipe.replace(/\$(cwd|args)\b/g, (_, name) => edge.bindings[name]!);
      expect(command).toStartWith("cmd /c ");
      await using proc = Bun.spawn(["cmd.exe", "/c", command.slice("cmd /c ".length)], {
        cwd: c.cfg.cwd,
        env: bunEnv,
        windowsVerbatimArguments: true,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      expect(stdout).toBe("");
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      expect(JSON.parse(readFileSync(resolve(cfg.codegenDir, "arguments.json"), "utf8"))).toEqual({
        cwd: checkout,
        sources: bindgen.map((path, i) => ({ path, text: `// ${names[i]}` })),
        types: cfg.typesDir,
      });
    });

  test("declares a .cpp and a .h per .bind.ts, the tables, a .rs per crate and the .d.ts, on one edge", () => {
    using dir = tempDir("build-codegen-bindgen", {});
    const c = configure(String(dir));
    const { cfg, n, o, dirStamp } = c;
    const bindgen = [
      resolve(cfg.cwd, "src", "runtime", "node", "node_os.bind.ts"),
      resolve(cfg.cwd, "src", "jsc", "fmt_jsc.bind.ts"),
    ];

    emitBindgen({ n, cfg, sources: sourceLists({ bindgen, bindgenCodegen: [] }), o, dirStamp });

    const inDir = (name: string) => resolve(cfg.codegenDir, name);
    const cpp = ["GeneratedFmtJsc.cpp", "GeneratedNodeOs.cpp"].map(inDir);
    const headers = [
      "GeneratedBindings+Classes.h",
      "GeneratedBindings+Counts.h",
      "GeneratedBindings+Tables.h",
      "GeneratedFmtJsc.h",
      "GeneratedNodeOs.h",
    ].map(inDir);
    const rust = ["generated_bindgen_bun_jsc.rs", "generated_bindgen_bun_runtime.rs"].map(inDir);
    const types = resolve(cfg.typesDir, "Bindgen.d.ts");
    expect(edgeOutputs(n, cpp[0])).toEqual([...cpp, ...headers, ...rust, types].map(p => n.rel(p)).sort());
    expect(normalized(o.cppSources)).toEqual(cpp);
    expect(normalized(o.cppHeaders)).toEqual(headers);
    expect(normalized(o.rustInputs)).toEqual(rust);
    expect(o.generatedTypes).toEqual([types]);
    expect(normalized(o.all)).toEqual(normalized([...cpp, ...headers, ...rust, types]));
  });

  test.concurrent(
    "declares exactly the files bindgen.ts writes for the repo's .bind.ts files",
    async () => {
      using dir = tempDir("build-codegen-bindgen-generate", {});
      const c = configure(String(dir));
      const { cfg, n, o, dirStamp } = c;
      const bindgen = repoBindFiles(cfg);
      expect(bindgen).not.toBeEmpty();

      emitBindgen({ n, cfg, sources: sourceLists({ bindgen, bindgenCodegen: [] }), o, dirStamp });

      const script = resolve(cfg.cwd, "src", "codegen", "bindgen.ts");
      const typesDir = resolve(String(dir), "types");
      const schemas = n
        .toString()
        .replaceAll("$:", ":")
        .match(/--(sources|types-only)=[^\s'"]*/g)!;
      expect(
        await bunRun([
          "run",
          script,
          ...new Set(schemas),
          `--codegen-path=${cfg.codegenDir}`,
          `--types-path=${typesDir}`,
        ]),
      ).toSpawn("");

      const written = readdirSync(cfg.codegenDir).sort();
      const declared = edgeOutputs(n, resolve(cfg.codegenDir, "GeneratedBindings+Tables.h"));
      expect(declared.filter(p => p !== n.rel(resolve(cfg.typesDir, "Bindgen.d.ts")))).toEqual(
        inCodegenDir(c, written),
      );
      expect(readdirSync(typesDir)).toEqual(["Bindgen.d.ts"]);
    },
    generatorTimeout,
  );
});
