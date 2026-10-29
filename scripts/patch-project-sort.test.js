const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { patchProjectSort } = require("./patch-project-sort");

// 保留真实选择器的两个缺陷：标题仅按索引排序，最终布局又套用 projectOrder。
const fixture = `const select=atom(Q,({sidebarMode:side,mode:view},{get:s})=>{
  let _=s(groups),m=s(links),N=s(cloud),I=s(prefs).chatSortMode,z=s(saved),me=N.projects,
  ge=[..._.projectGroups.map(e=>({key:m.has(e.projectId)?Ox(m.get(e.projectId)):Dx(e.projectId),kind:\`project\`,pinned:e.pinned??false})),
  ...me.map(({isPinned:e,project:t})=>({key:Ox(t.gizmo.id),kind:\`project\`,pinned:e,source:\`chatgpt\`})),
  ..._.threadKeys.map(e=>({key:e,kind:\`conversation\`,recencyAt:QK(s,e)}))],
  ve=new Map(_.projectGroups.map((e,t)=>{let n=m.get(e.projectId);return[n==null?Dx(e.projectId):Ox(n),t]})),
  ye=ge.filter(e=>e.kind===\`project\`).filter(e=>!e.pinned).sort((e,t)=>(ve.get(e.key)??2**53-1)-(ve.get(t.key)??2**53-1)),
  input={projectEntries:ye,options:{pinnedSortMode:I,projectOrder:z}};
  N.chatTargets.map(e=>e.recencyAt);
  return input;
});`;

const groups = [{ projectId: "old", threadKeys: ["a"], projectUpdatedAt: 20 },
  { projectId: "recent", threadKeys: ["b"], projectCreatedAt: 30 },
  { projectId: "empty", threadKeys: [], projectCreatedAt: 200 }];
const saved = ["codex:project:old", "codex:project:empty", "codex:project:recent"];

function execute(code, mode, options = {}) {
  const values = { groups: { projectGroups: options.groups ?? groups, threadKeys: ["a", "b"] },
    links: options.links ?? new Map(), cloud: { projects: options.projects ?? [], chatTargets: options.chats ?? [] },
    prefs: { chatSortMode: mode, projectSortMode: mode }, saved: options.saved ?? saved };
  const context = { Q: null, atom: (_, selector) => selector,
    groups: "groups", links: "links", cloud: "cloud", prefs: "prefs", saved: "saved",
    Dx: id => "codex:project:" + id, Ox: id => "chatgpt:project:" + id,
    QK: (_, key) => ({ a: 100, b: 300 }[key] ?? 0), get: key => values[key],
    layout: (projectEntries, options) => ({ projectEntries, options }) };
  vm.createContext(context);
  vm.runInContext(code + ";globalThis.output=select({sidebarMode:`codex`,mode:`project`},{get});", context);
  const { projectEntries, options: { projectOrder } } = context.output;
  // 与生产 jOi 相同的最终投影，必须保留以暴露“第二次覆盖顺序”的回归。
  const available = new Set(projectEntries.map(e => e.key));
  const retained = new Set(projectOrder);
  return [...Array.from(projectOrder).filter(key => available.has(key)),
    ...Array.from(projectEntries).filter(e => !retained.has(e.key)).map(e => e.key)];
}

test("模式切换作用于最终项目标题且保留手动顺序", () => {
  assert.deepEqual(execute(fixture, "updated_at"), saved, "未修复的夹具重现故障");
  const result = patchProjectSort(fixture);
  assert.equal(result.status, "patched");
  assert.deepEqual(execute(result.code, "manual"), saved);
  assert.deepEqual(execute(result.code, "updated_at"), ["codex:project:recent", "codex:project:empty", "codex:project:old"]);
  assert.deepEqual(execute(result.code, "manual"), saved);
  assert.deepEqual(patchProjectSort(result.code), { code: result.code, status: "already-patched" });
});

test("空项目、相同时间、置顶和云端会话活动", () => {
  const { code } = patchProjectSort(fixture);
  assert.deepEqual(execute(code, "updated_at", { groups: [] }), []);
  assert.deepEqual(execute(code, "updated_at", { groups: [{ projectId: "a", threadKeys: [] }, { projectId: "b", threadKeys: [] }], saved: [] }), ["codex:project:a", "codex:project:b"]);
  assert.deepEqual(execute(code, "updated_at", { groups: groups.map(g => ({ ...g, pinned: true })) }), []);
  const projects = [{ isPinned: false, project: { gizmo: { id: "cloud", updated_at: "invalid" } } }];
  assert.equal(execute(code, "updated_at", { projects, chats: [{ projectId: "cloud", recencyAt: 999 }] })[0], "chatgpt:project:cloud");
  assert.equal(execute(code, "updated_at", { projects: [{ isPinned: false, project: { gizmo: { id: "linked", updated_at: "1970-01-01T00:00:01Z" } } }], links: new Map([["old", "linked"]]) })[0], "chatgpt:project:linked");
});

test("兼容变量改名、单字符符号与旧版内联布局", () => {
  // getter 改为单字符 t，验证新增回调没有用 t 遮蔽上游符号。
  const renamedSafe = fixture.replace(/\bs\b/g, "t").replace(/\bve\b/g, "$index").replace(/\bQK\b/g, "$recency");
  const result = patchProjectSort(renamedSafe);
  assert.equal(result.status, "patched");
  assert.deepEqual(execute(result.code.replace(/\$recency/g, "QK"), "updated_at"), ["codex:project:recent", "codex:project:empty", "codex:project:old"]);
  const inline = fixture.replace("ye=ge.filter", "input=layout([...ge.filter")
    .replace(",\n  input={projectEntries:ye,options:{pinnedSortMode:I,projectOrder:z}};", "],{pinnedSortMode:I,projectOrder:z});");
  const legacy = patchProjectSort(inline);
  assert.equal(legacy.status, "patched");
  assert.deepEqual(execute(legacy.code, "manual"), saved);
  assert.deepEqual(execute(legacy.code, "updated_at"), ["codex:project:recent", "codex:project:empty", "codex:project:old"]);
});

test("上游明确按模式排序时保持原样，未知结构中止", () => {
  const fixed = fixture.replace("(e,t)=>(ve.get(e.key)??2**53-1)-(ve.get(t.key)??2**53-1)",
    "(e,t)=>s(prefs).projectSortMode===`manual`?(ve.get(e.key)??0)-(ve.get(t.key)??0):t.recencyAt-e.recencyAt")
    .replace("pinnedSortMode:I,projectOrder:z", "pinnedSortMode:I,projectOrder:s(prefs).projectSortMode===`manual`?z:[]");
  assert.deepEqual(patchProjectSort(fixed), { code: fixed, status: "upstream-managed" });
  assert.throws(() => patchProjectSort(fixture.replace("2**53-1", "100")), /upstream review required/);
  assert.throws(() => patchProjectSort("const unrelated = 1;"), /upstream review required/);
  assert.throws(() => patchProjectSort(fixture + fixture.replace("select=", "other=")), /expected one sidebar selector/);
});
