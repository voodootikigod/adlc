import { test } from "node:test";
import assert from "node:assert/strict";
import { globMatch, shellHasMutation, collectShellPaths } from "../index.js";

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

test("globMatch: handles regex characters safely", () => {
	assert.ok(globMatch("src-plus+/**/*.ts", "src-plus+/foo.ts"));
	assert.ok(!globMatch("src-plus+/**/*.ts", "src-plus/foo.ts"));
});

// =========================================================================
// 2. shellHasMutation Tests (including Sync variants)
// =========================================================================

test("shellHasMutation: detects shell redirects", () => {
	assert.ok(shellHasMutation("echo 'hello' > src/foo.ts"));
	assert.ok(shellHasMutation("cat file.ts >> test/output.ts"));
	assert.ok(shellHasMutation("node build.js 2> err.log"));
});

test("shellHasMutation: detects shell mutation commands", () => {
	assert.ok(shellHasMutation("rm -rf test/"));
	assert.ok(shellHasMutation("mv src/old.ts src/new.ts"));
	assert.ok(shellHasMutation("sed -i 's/foo/bar/g' index.ts"));
});

test("shellHasMutation: detects node fs mutation APIs (specifically Sync variants)", () => {
	// These were failing in the second adversarial review pass!
	assert.ok(shellHasMutation("node -e \"fs.writeFileSync('src/contract.ts', 'x')\""));
	assert.ok(shellHasMutation("node -e \"fs.appendFileSync('test.log', 'y')\""));
	assert.ok(shellHasMutation("node -e \"fs.copyFileSync('a', 'b')\""));
	
	// Original non-Sync variants
	assert.ok(shellHasMutation("node -e \"fs.writeFile('src/contract.ts', 'x')\""));
	assert.ok(shellHasMutation("node -e \"fs.appendFile('test.log', 'y')\""));
});

test("shellHasMutation: ignores read-only commands", () => {
	assert.ok(!shellHasMutation("git status"));
	assert.ok(!shellHasMutation("cat src/contract.ts"));
	assert.ok(!shellHasMutation("node src/index.js"));
	assert.ok(!shellHasMutation("npm test"));
});

// =========================================================================
// 3. collectShellPaths Tests
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
