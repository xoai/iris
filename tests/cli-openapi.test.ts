// C3 (openapi-transport): loadOpenApiTools parses an OpenAPI 3.0 spec into
// http:// operation-tool contracts + HttpSpecs (named by operationId), merging
// parameters + a $ref'd requestBody into one inputSchema; loud rejects; and
// composeResolvers (first-non-null). Pure CI (filesystem fixtures, no network/docker).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOpenApiTools } from "iris-runtime";
import { composeResolvers, makeLocalResolver } from "@irisrun/agent";
import type { ToolContract } from "@irisrun/tools";

type Schema = { type: string; properties: Record<string, unknown>; required?: string[] };

const SPEC = {
  openapi: "3.0.0",
  info: { title: "Pets", version: "1.0.0" },
  components: {
    schemas: { Pet: { type: "object", properties: { name: { type: "string" }, tag: { type: "string" } }, required: ["name"] } },
  },
  paths: {
    "/pets/{id}": {
      get: {
        operationId: "getPet",
        summary: "Get a pet",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "verbose", in: "query", schema: { type: "boolean" } },
        ],
      },
    },
    "/pets": {
      post: { operationId: "createPet", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } } } },
    },
  },
};

async function fixtureWith(spec: unknown, entry: Record<string, unknown> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "iris-openapi-"));
  await writeFile(join(dir, "spec.json"), JSON.stringify(spec));
  await writeFile(join(dir, "openapi.json"), JSON.stringify([{ name: "petstore", spec: "spec.json", baseUrl: "https://api.example.com/v1", ...entry }]));
  return join(dir, "openapi.json");
}

test("generates one http contract per operation (named by operationId)", async () => {
  const { contracts } = await loadOpenApiTools(await fixtureWith(SPEC));
  const byName = Object.fromEntries(contracts.map((c) => [c.name, c]));
  assert.deepEqual(contracts.map((c) => c.name).sort(), ["createPet", "getPet"]);
  assert.equal(byName.getPet.transport, "http");
  assert.equal(byName.getPet.location, "http://petstore/getPet");
  assert.equal(byName.getPet.retrySafe, true); // GET
  assert.equal(byName.createPet.retrySafe, false); // POST
});

test("getPet inputSchema merges path + query params", async () => {
  const { contracts } = await loadOpenApiTools(await fixtureWith(SPEC));
  const s = contracts.find((c) => c.name === "getPet")!.inputSchema as Schema;
  assert.equal(s.type, "object");
  assert.ok("id" in s.properties && "verbose" in s.properties);
  assert.deepEqual(s.required, ["id"]);
});

test("createPet resolves a local $ref requestBody into the inputSchema", async () => {
  const { contracts } = await loadOpenApiTools(await fixtureWith(SPEC));
  const s = contracts.find((c) => c.name === "createPet")!.inputSchema as Schema;
  assert.ok("name" in s.properties && "tag" in s.properties, "Pet props merged");
  assert.ok((s.required ?? []).includes("name"));
});

test("httpSpecs carry baseUrl/method/path/query + authSecretEnv", async () => {
  const { httpSpecs } = await loadOpenApiTools(await fixtureWith(SPEC, { authSecretEnv: "PETS_KEY" }));
  assert.equal(httpSpecs["petstore/getPet"].method, "GET");
  assert.equal(httpSpecs["petstore/getPet"].path, "/pets/{id}");
  assert.deepEqual(httpSpecs["petstore/getPet"].query, ["verbose"]);
  assert.equal(httpSpecs["petstore/getPet"].authSecretEnv, "PETS_KEY");
  assert.equal(httpSpecs["petstore/createPet"].method, "POST");
});

test("the resolver resolves the generated http:// refs", async () => {
  const { resolver } = await loadOpenApiTools(await fixtureWith(SPEC));
  assert.equal((await resolver.resolve("http://petstore/getPet"))?.name, "getPet");
  assert.equal(await resolver.resolve("http://petstore/nope"), null);
});

test("missing config → empty (zero-value-off)", async () => {
  const r = await loadOpenApiTools(join(tmpdir(), "iris-no-such-openapi.json"));
  assert.deepEqual(r.contracts, []);
});

test("rejects a duplicate operationId", async () => {
  const spec = { openapi: "3.0.0", info: { title: "x", version: "1" }, paths: { "/a": { get: { operationId: "same" } }, "/b": { get: { operationId: "same" } } } };
  const cfg = await fixtureWith(spec);
  await assert.rejects(() => loadOpenApiTools(cfg), /duplicate operationId/);
});

test("rejects a non-3.0 spec", async () => {
  const cfg = await fixtureWith({ swagger: "2.0", paths: {} });
  await assert.rejects(() => loadOpenApiTools(cfg), /OpenAPI 3.0/);
});

test("rejects a missing operationId", async () => {
  const cfg = await fixtureWith({ openapi: "3.0.0", info: { title: "x", version: "1" }, paths: { "/a": { get: { summary: "no opid" } } } });
  await assert.rejects(() => loadOpenApiTools(cfg), /operationId/);
});

test("rejects an unsupported $ref", async () => {
  const spec = { openapi: "3.0.0", info: { title: "x", version: "1" }, paths: { "/a": { post: { operationId: "op", requestBody: { content: { "application/json": { schema: { $ref: "https://example.com/x.json#/Foo" } } } } } } } };
  const cfg = await fixtureWith(spec);
  await assert.rejects(() => loadOpenApiTools(cfg), /\$ref/);
});

test("a requestBody property colliding with a param nests the body under `body`", async () => {
  const spec = {
    openapi: "3.0.0", info: { title: "x", version: "1" },
    paths: { "/items/{data}": { post: {
      operationId: "mk",
      parameters: [{ name: "data", in: "path", required: true, schema: { type: "string" } }],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { data: { type: "number" }, note: { type: "string" } }, required: ["data"] } } } },
    } } },
  };
  const cfg = await fixtureWith(spec);
  const { contracts } = await loadOpenApiTools(cfg);
  const s = contracts[0]!.inputSchema as Schema;
  assert.ok("data" in s.properties && "body" in s.properties, "collision → body nested under `body`");
  assert.ok(!("note" in s.properties), "body props are NOT flattened on collision");
  assert.ok((s.required ?? []).includes("body"));
});

test("composeResolvers: first non-null wins, else fall through", async () => {
  const mk = (loc: string, t: ToolContract["transport"]): ToolContract => ({ name: loc, description: "", inputSchema: {}, transport: t, location: loc, retrySafe: true });
  const a = makeLocalResolver({ "mcp://x": mk("mcp://x", "mcp") });
  const b = makeLocalResolver({ "http://y": mk("http://y", "http") });
  const c = composeResolvers(a, b);
  assert.equal((await c.resolve("mcp://x"))?.location, "mcp://x");
  assert.equal((await c.resolve("http://y"))?.location, "http://y");
  assert.equal(await c.resolve("mcp://none"), null);
});
