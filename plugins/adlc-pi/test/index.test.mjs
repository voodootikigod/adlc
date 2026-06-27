import { test } from "node:test";
import assert from "node:assert/strict";
import { 
	globMatch, 
	shellHasMutation, 
	collectShellPaths, 
	canonicalizePath, 
	isPathBlocked, 
	isPathInScope, 
	getAllowedSuppressions 
} from "../index.js";

const dummyTicket = {
	id: "T1",
	title: "Test Ticket",
	body: "Fix some bugs\nallow-suppression: @ts-ignore\nallow-suppression: .skip(",
	scope: ["src/**/*.ts", "packages/core/**"],
	rails: ["test/contracts/**", "schema/types.ts"],
	allowedSuppressions: ["eslint-disable"]
};

// =========================================================================
// 1. globMatch Tests
// =========================================================================

test("globMatch: literal patterns", () => {
	assert.ok(globMatch("src/foo.ts", "src/foo.ts"));
	assert.ok(!globMatch("src/foo.ts", "src/bar.ts"));
});

test("globMatch: single wildcard (*)", () => {
	assert.ok(globMatch("src/*.ts", "src/foo.ts"));
	assert.ok(globMatch("src/*.ts", "src/bar.ts"));
	assert.ok(!globMatch("src/*.ts", "src/nested/foo.ts"));
	assert.ok(!globMatch("src/*.ts", "test/foo.ts"));
});

test("globMatch: recursive wildcard (**)", () => {
	assert.ok(globMatch("src/**/*.ts", "src/foo.ts"));
	assert.ok(globMatch("src/**/*.ts", "src/nested/foo.ts"));
	assert.ok(globMatch("src/**/*.ts", "src/nested/deep/foo.ts"));
	assert.ok(!globMatch("src/**/*.ts", "test/foo.ts"));
});

// =========================================================================
// 2. Path Canonicalization & Protection Tests
// =========================================================================

test("canonicalizePath: normalizes relative paths", () => {
	const cwd = "/workspace/repo";
	assert.equal(canonicalizePath("./src/foo.ts", cwd), "src/foo.ts");
	assert.equal(canonicalizePath("src/../src/foo.ts", cwd), "src/foo.ts");
	assert.equal(canonicalizePath("/workspace/repo/src/foo.ts", cwd), "src/foo.ts");
});

test("isPathBlocked: blocks ticket database and active ticket context files unconditionally", () => {
	const cwd = "/workspace/repo";
	assert.ok(isPathBlocked(".adlc/tickets.json", dummyTicket, cwd));
	assert.ok(isPathBlocked("./.adlc/tickets.json", dummyTicket, cwd));
	assert.ok(isPathBlocked(".adlc/current-ticket.json", dummyTicket, cwd));
	assert.ok(isPathBlocked("./.adlc/current-ticket.json", dummyTicket, cwd));
});

test("isPathBlocked: blocks files matching frozen rails", () => {
	const cwd = "/workspace/repo";
	assert.ok(isPathBlocked("test/contracts/auth.test.ts", dummyTicket, cwd));
	assert.ok(isPathBlocked("./test/contracts/auth.test.ts", dummyTicket, cwd));
	assert.ok(isPathBlocked("schema/types.ts", dummyTicket, cwd));
	assert.ok(!isPathBlocked("src/foo.ts", dummyTicket, cwd));
});

test("isPathInScope: enforces ticket scope rules", () => {
	const cwd = "/workspace/repo";
	assert.ok(isPathInScope("src/foo.ts", dummyTicket, cwd));
	assert.ok(isPathInScope("./src/nested/bar.ts", dummyTicket, cwd));
	assert.ok(isPathInScope("packages/core/index.mjs", dummyTicket, cwd));
	assert.ok(!isPathInScope("test/auth.test.ts", dummyTicket, cwd)); // out of scope
});

test("isPathInScope: permits framework dirs while preserving config protection", () => {
	const cwd = "/workspace/repo";
	// Framework logs/manifest files allowed in scope
	assert.ok(isPathInScope(".adlc/manifest.jsonl", dummyTicket, cwd));
	assert.ok(isPathInScope(".omo/evidence.txt", dummyTicket, cwd));
});

// =========================================================================
// 3. Suppression Gating Parser Tests
// =========================================================================

test("getAllowedSuppressions: parses allowed suppressions from ticket structured field and body text", () => {
	const allowed = getAllowedSuppressions(dummyTicket);
	assert.ok(allowed.includes("eslint-disable")); // from allowedSuppressions array
	assert.ok(allowed.includes("@ts-ignore")); // from body text matching prefix
	assert.ok(allowed.includes(".skip(")); // from body text matching prefix
	assert.ok(!allowed.includes("eslint-disable-next-line")); // not explicitly allowed
});

// =========================================================================
// 4. shellHasMutation Tests (covering Sync & Git porcelain commands)
// =========================================================================

test("shellHasMutation: detects shell redirects", () => {
	assert.ok(shellHasMutation("echo 'hello' > src/foo.ts"));
	assert.ok(shellHasMutation("cat file.ts >> test/output.ts"));
});

test("shellHasMutation: detects git porcelain mutation sub-commands", () => {
	assert.ok(shellHasMutation("git checkout main -- test/contract.test.ts"));
	assert.ok(shellHasMutation("git restore --source=HEAD --staged test/contract.test.ts"));
	assert.ok(shellHasMutation("git apply my-patch.patch"));
	assert.ok(shellHasMutation("git reset HEAD test.ts"));
});

test("shellHasMutation: detects node fs mutation APIs (specifically Sync variants)", () => {
	assert.ok(shellHasMutation("node -e \"fs.writeFileSync('src/contract.ts', 'x')\""));
	assert.ok(shellHasMutation("node -e \"fs.appendFileSync('test.log', 'y')\""));
	assert.ok(shellHasMutation("node -e \"fs.copyFileSync('a', 'b')\""));
});

test("shellHasMutation: ignores read-only commands", () => {
	assert.ok(!shellHasMutation("git status"));
	assert.ok(!shellHasMutation("git diff HEAD"));
	assert.ok(!shellHasMutation("cat src/contract.ts"));
});

// =========================================================================
// 5. collectShellPaths Tests
// =========================================================================

test("collectShellPaths: extracts redirect targets", () => {
	const paths = collectShellPaths("echo 'foo' > build/output.js");
	assert.ok(paths.includes("build/output.js"));
});

test("collectShellPaths: extracts quoted targets", () => {
	const paths = collectShellPaths("node script.js --file 'src/contract.ts' \"test/bar.ts\"");
	assert.ok(paths.includes("src/contract.ts"));
	assert.ok(paths.includes("test/bar.ts"));
});

test("collectShellPaths: extracts path-like arguments", () => {
	const paths = collectShellPaths("sed -i 's/x/y/g' src/main.ts test/main.test.ts");
	assert.ok(paths.includes("src/main.ts"));
	assert.ok(paths.includes("test/main.test.ts"));
});
