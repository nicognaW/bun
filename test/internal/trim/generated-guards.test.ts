import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { bunEnv, bunExe, tempDir } from "harness";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { readBuiltinUses } from "../../../scripts/build/trim/builtin-uses.ts";
import type { BuiltinEntry, BuiltinKind } from "../../../scripts/build/trim/types.ts";
import { Guards, textOfStaticTableEntry } from "../../../src/codegen/builtins/guards.ts";
import { removableFeatures } from "../../../src/codegen/removable-entry-points.ts";
import { builtinUsesPath, builtinUsesSkipReason, findBuiltinUses, skipNotice } from "./toy-program.ts";

setDefaultTimeout(60_000);

const [feature, otherFeature] = removableFeatures()
  .features.filter(each => !each.isEngine)
  .map(each => each.name) as [string, string];

const entry = (id: number, path: string, kind: BuiltinKind, uses: BuiltinEntry["uses"]): BuiltinEntry => ({
  id,
  path,
  kind,
  uses,
  nativeSymbols: [],
  hasHiddenRoot: false,
});
const always = (name: string) => ({ feature: name, isConditional: false });
const sometimes = (name: string) => ({ feature: name, isConditional: true });

const createHashTable = join(import.meta.dir, "../../../src/codegen/create-hash-table.ts");

function generate(tables: string): string {
  using dir = tempDir("generated-guards", { "tables.cpp": `/* Source for tables.lut.h\n${tables}\n*/\n` });
  const output = join(String(dir), "tables.lut.h");
  const { exitCode } = Bun.spawnSync({
    cmd: [bunExe(), createHashTable, join(String(dir), "tables.cpp"), output],
    env: bunEnv,
    stdout: "ignore",
    stderr: "inherit",
  });
  expect(exitCode).toBe(0);
  return readFileSync(output, "utf8");
}

const valuesOf = (text: string, entryKey: string) =>
  text
    .split("\n")
    .filter(line => line.startsWith(`   { "${entryKey}"_s,`))
    .map(line => line.slice(line.indexOf("{ HashTableValue::")));

describe.skipIf(Bun.which("perl") === null)("create-hash-table.ts", () => {
  test("a table holds the functions themselves: what was removed is replaced where a pointer becomes callable", () => {
    const text = generate(`@begin bunObjectTable
    call    functionCall    DontDelete|Function 2
    size    jsThingSize     DontDelete|CustomAccessor
    lazy    createLazy      ReadOnly|DontDelete|PropertyCallback
@end`);
    expect(valuesOf(text, "call")).toEqual([`{ HashTableValue::NativeFunctionType, &functionCall, 2 } },`]);
    expect(valuesOf(text, "size")).toEqual([`{ HashTableValue::GetterSetterType, jsThingSize, setJSThingSize } },`]);
    expect(valuesOf(text, "lazy")).toEqual([`{ HashTableValue::LazyPropertyType, createLazy } },`]);
    expect(text).not.toContain("Removable");
    expect(text).not.toContain("removable");
  });
});

describe("Guards", () => {
  const named = (id: number, path: string, nativeSymbols: string[]): BuiltinEntry => ({
    ...entry(id, path, "Function", [always(feature)]),
    nativeSymbols,
  });

  test("finds an entry by the symbol of its function, the first entry where two name one symbol", () => {
    const bySymbol = new Guards({
      entries: [
        named(1, "Bun.first", ["Generated::jsShared", "Generated::jsFirst"]),
        named(2, "Bun.second", ["Generated::jsShared"]),
      ],
    });
    expect(bySymbol.textOfNativeSymbol("Generated::jsFirst")).toBe("Bun.first");
    expect(bySymbol.textOfNativeSymbol("Generated::jsShared")).toBe("Bun.first");
    expect(bySymbol.textOfNativeSymbol("jsFirst")).toBeNull();
    expect(bySymbol.ofPath("Bun.second")).toEqual({ feature, builtin: 2 });
  });

  test("finds a namespace by the symbol of the callback that creates it, so its members find their guards", () => {
    const namespaces = new Guards({
      entries: [
        { ...entry(1, "Bun.TOML", "Namespace", [always(feature)]), creationSymbol: "Generated::createTOML" },
        entry(2, "Bun.TOML.parse", "Function", [always(feature)]),
      ],
    });
    const holder = namespaces.textOfNativeSymbol("Generated::createTOML");
    expect(holder).toBe("Bun.TOML");
    expect(namespaces.ofPath(textOfStaticTableEntry(holder!, "parse"))).toEqual({ feature, builtin: 2 });
  });

  test("a module is found by its specifier only", () => {
    const modules = new Guards({
      entries: [
        entry(1, "bun:removable", "Module", [always(feature)]),
        entry(2, "internal/removable", "InternalModule", [always(otherFeature)]),
      ],
    });
    expect(modules.ofModule("bun:removable")).toEqual({ feature, builtin: 1 });
    expect(modules.ofModule("internal/removable")).toEqual({ feature: otherFeature, builtin: 2 });
    expect(modules.ofPath("bun:removable")).toBeNull();
    expect(modules.ofModule("bun:other")).toBeNull();
  });
});

test("finds trim metadata paired with Bun before other build profiles", () => {
  using dir = tempDir("trim-builtin-uses-discovery", {
    override: { "builtin-uses.json": "invalid explicit metadata" },
    artifact: {
      "builtin-uses.json": "artifact",
      codegen: { "builtin-uses.json": "local build" },
    },
    build: { other: { codegen: { "builtin-uses.json": "other profile" } } },
  });
  const root = String(dir);
  const executable = join(root, "artifact", "bun.exe");
  const builds = join(root, "build");
  const override = join(root, "override");
  const overridden = findBuiltinUses(executable, override, builds);
  expect(overridden).toBe(join(override, "builtin-uses.json"));
  expect(() => readBuiltinUses(overridden!)).toThrow(SyntaxError);

  const artifact = join(root, "artifact", "builtin-uses.json");
  expect(findBuiltinUses(executable, undefined, builds)).toBe(artifact);
  expect(findBuiltinUses(executable, join(root, "missing override"), builds)).toBe(artifact);
  unlinkSync(artifact);
  const local = join(root, "artifact", "codegen", "builtin-uses.json");
  expect(findBuiltinUses(executable, undefined, builds)).toBe(local);
  unlinkSync(local);
  const other = join(builds, "other", "codegen", "builtin-uses.json");
  expect(findBuiltinUses(executable, undefined, builds)).toBe(other);
  unlinkSync(other);
  expect(findBuiltinUses(executable, undefined, builds)).toBeUndefined();
});

if (builtinUsesSkipReason !== undefined) skipNotice("generated-guards.test.ts", builtinUsesSkipReason);

test.skipIf(builtinUsesPath === undefined)(
  "the guard inside a bindgen function is the guard on its bunObjectTable entry",
  () => {
    const realGuards = new Guards(readBuiltinUses(builtinUsesPath!));
    const source = readFileSync(join(import.meta.dir, "../../../src/jsc/bindings/BunObject.cpp"), "utf8");
    const table = /@begin bunObjectTable\s(.*?)@end/s.exec(source)![1]!;
    const entries = [...table.matchAll(/^\s*(\S+)\s+(Bun::Bindgen::Generated::\w+::\w+)\s+\S*\bFunction\b/gm)];
    expect(entries.length).toBeGreaterThan(0);
    const guardedEntries = entries.flatMap(([, entryKey, symbol]) => {
      const text = realGuards.textOfNativeSymbol(symbol!);
      const inside = text === null ? null : realGuards.ofPath(text);
      return inside === null
        ? []
        : [{ entryKey, symbol, inside, onEntry: realGuards.ofPath(textOfStaticTableEntry("Bun", entryKey!)) }];
    });
    expect(guardedEntries.length).toBeGreaterThan(0);
    expect(guardedEntries.filter(({ inside, onEntry }) => !Bun.deepEquals(inside, onEntry))).toEqual([]);
  },
);
