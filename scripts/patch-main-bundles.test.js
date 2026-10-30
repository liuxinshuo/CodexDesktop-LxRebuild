const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { parse } = require("acorn");

function fixture(t, files, flat = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-main-patch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  const build = path.join(root, "src", ...(flat ? [] : ["win", "_asar"]), ".vite", "build");
  fs.mkdirSync(build, { recursive: true });
  for (const name of ["patch-util.js", "patch-copyright.js", "patch-devtools.js"]) {
    fs.copyFileSync(path.join(__dirname, name), path.join(root, "scripts", name));
  }
  for (const [name, code] of Object.entries(files)) fs.writeFileSync(path.join(build, name), code, "utf8");
  return {
    read: name => fs.readFileSync(path.join(build, name), "utf8"),
    locate: options => require(path.join(root, "scripts", "patch-util.js")).locateBundles(options),
    run(script, ...args) {
      return spawnSync(process.execPath, [path.join(root, "scripts", script), ...(flat ? [] : ["win"]), ...args], {
        encoding: "utf8", env: { ...process.env, NODE_PATH: path.join(__dirname, "..", "node_modules") },
      });
    },
  };
}

const copyright = 'app.setAboutPanelOptions({copyright:"© OpenAI"});';
const devtools = "const options={allowInspectElement:settings.inspect,devTools:settings.allowDevtools};";

for (const [layout, files] of Object.entries({
  legacy: { "main.js": copyright + devtools },
  hashed: { "main.js": 'require("./main-abc.js");', "main-abc.js": copyright + devtools },
  flat: { "early-bootstrap.js": "const startup=true;", "early-bootstrap-1.js": copyright + devtools },
  // 新版入口只负责加载，目标属性分布在多个分块，不能只修改第一个匹配文件。
  chunks: { "early-bootstrap.js": 'require("./early-bootstrap-339-abc.js");',
    "early-bootstrap-339-abc.js": copyright, "early-bootstrap-491-def.js": devtools,
    "worker.js": 'const unrelated={devTools:false};const label="allowInspectElement";' },
})) {
  test(`主进程补丁兼容 ${layout}，检查不写入且重复执行幂等`, t => {
    const f = fixture(t, files, layout === "flat");
    if (layout === "hashed") {
      // 默认调用者仍只选择哈希主文件，all 的引入不能改变现有选择行为。
      assert.deepEqual(f.locate({ dir: "build", pattern: /^main(-[^.]+)?\.js$/, platform: "win" })
        .map(bundle => path.basename(bundle.path)), ["main-abc.js"]);
    }
    for (const script of ["patch-copyright.js", "patch-devtools.js"]) {
      const check = f.run(script, "--check");
      assert.equal(check.status, 0, check.stdout + check.stderr);
      assert.match(check.stdout, /Matches: 1|Matches: 2/);
    }
    for (const [name, code] of Object.entries(files)) assert.equal(f.read(name), code);
    for (const script of ["patch-copyright.js", "patch-devtools.js"]) {
      const result = f.run(script);
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    const output = Object.fromEntries(Object.keys(files).map(name => [name, f.read(name)]));
    const combined = Object.values(output).join("\n");
    assert.match(combined, /© OpenAI · Cometix Space/);
    assert.match(combined, /allowInspectElement:!0,devTools:!0/);
    if (files["worker.js"]) assert.equal(output["worker.js"], files["worker.js"]);
    for (const code of Object.values(output)) parse(code, { ecmaVersion: "latest", sourceType: "module" });
    for (const script of ["patch-copyright.js", "patch-devtools.js"]) assert.equal(f.run(script).status, 0);
    for (const [name, code] of Object.entries(output)) assert.equal(f.read(name), code);
  });
}

test("缺失资源仍中止；目标分块语法错误时保留原文件", t => {
  for (const files of [{}, { "early-bootstrap-1.js": copyright + devtools + "(" }]) {
    const f = fixture(t, files);
    for (const script of ["patch-copyright.js", "patch-devtools.js"]) {
      const result = f.run(script);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /No main bundle found|SyntaxError/);
    }
    for (const [name, code] of Object.entries(files)) assert.equal(f.read(name), code);
  }
});
