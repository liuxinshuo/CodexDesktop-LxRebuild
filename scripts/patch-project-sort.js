#!/usr/bin/env node
/** 打包前修复项目标题始终采用手动顺序的问题；不绑定资源 hash 或压缩符号名。 */
const fs = require("node:fs");
const acorn = require("acorn");
const { locateBundles, relPath } = require("./patch-util");

const MARKER = "lx-project-sort-v1";
const ID = "[A-Za-z_$][\\w$]*";
const textValue = (node) => node?.type === "Literal" ? node.value
  : node?.type === "TemplateLiteral" && node.expressions.length === 0 ? node.quasis[0].value.cooked : undefined;
const member = (node, name) => node?.type === "MemberExpression" && !node.computed && node.property.name === name;
const property = (node, name) => node?.properties?.find((p) => p.key?.name === name);

function walk(node, visit, parent) {
  if (!node || typeof node.type !== "string") return;
  visit(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit, node));
    else if (value && typeof value.type === "string") walk(value, visit, node);
  }
}

function patchProjectSort(code) {
  if (code.includes(`/* ${MARKER}:`)) return { code, status: "already-patched" };
  const selectors = [];
  // 只解析侧栏选择器表达式，避免为整个十余 MB bundle 建立 AST。
  const selectorPattern = new RegExp(`\\(\\{sidebarMode:${ID},[^{}]*\\},\\{get:${ID}\\}\\)=>\\{`, "g");
  for (const match of code.matchAll(selectorPattern)) {
    const expression = acorn.parseExpressionAt(code, match.index, { ecmaVersion: "latest", sourceType: "module" });
    const selector = expression.type === "SequenceExpression" ? expression.expressions[0] : expression;
    if (selector.type === "ArrowFunctionExpression" && code.slice(selector.start, selector.end).includes(".projectGroups")) selectors.push(selector);
  }
  const candidates = [];
  for (const selector of selectors) {
    const nodes = [];
    walk(selector.body, (node, parent) => nodes.push({ node, parent }));
    const sorts = nodes.map(({ node }) => node).filter((node) => {
      if (node.type !== "CallExpression" || !member(node.callee, "sort")) return false;
      const outer = node.callee.object;
      const inner = outer?.callee?.object;
      return member(outer?.callee, "filter") && member(inner?.callee, "filter") &&
        outer.arguments[0]?.body?.operator === "!" && member(outer.arguments[0].body.argument, "pinned") &&
        inner.arguments[0]?.body?.operator === "===" && member(inner.arguments[0].body.left, "kind") &&
        textValue(inner.arguments[0].body.right) === "project";
    });
    const orderOptions = nodes.filter(({ node, parent }) => node.type === "Property" && node.key.name === "projectOrder" && property(parent, "pinnedSortMode"));
    if (sorts.length || orderOptions.length) candidates.push({ selector, nodes, sorts, orderOptions });
  }
  if (candidates.length !== 1) throw new Error(`Project sort: expected one sidebar selector, found ${candidates.length}; upstream review required`);
  const { selector, nodes, sorts, orderOptions } = candidates[0];
  if (sorts.length !== 1 || orderOptions.length !== 1) throw new Error("Project sort: ambiguous heading/order expressions; upstream review required");
  const sort = sorts[0], order = orderOptions[0].node;
  const source = (node) => code.slice(node.start, node.end);
  const getter = property(selector.params[1], "get").value.name;
  const preferences = nodes.map(({ node }) => node).filter((node) => member(node, "chatSortMode") && node.object.type === "CallExpression" && node.object.callee.name === getter);
  if (preferences.length !== 1) throw new Error("Project sort: cannot resolve sidebar preferences");
  const mode = `${source(preferences[0].object)}.projectSortMode`;
  const compare = sort.arguments[0];
  const manualComparator = new RegExp(`^\\((${ID}),(${ID})\\)=>\\((${ID})\\.get\\(\\1\\.key\\)\\?\\?2\\*\\*53-1\\)-\\(\\3\\.get\\(\\2\\.key\\)\\?\\?2\\*\\*53-1\\)$`);
  const manual = source(compare).match(manualComparator);
  if (!manual) {
    // 仅当两个环节都明确由模式控制时，才认可上游已有排序；未知改动不能静默放行。
    const conditional = order.value;
    if (conditional.type === "ConditionalExpression" && source(conditional.test) === `${mode}===\`manual\`` &&
        conditional.alternate.type === "ArrayExpression" && conditional.alternate.elements.length === 0 &&
        source(compare).includes(mode) && /recencyAt|projectUpdatedAt/.test(source(compare))) {
      return { code, status: "upstream-managed" };
    }
    throw new Error("Project sort: unknown comparator; upstream review required");
  }
  if (order.value.type !== "Identifier") throw new Error("Project sort: unexpected final projectOrder; upstream review required");
  const indexName = manual[3];
  const index = nodes.map(({ node }) => node).find((node) => node.type === "VariableDeclarator" && node.id.name === indexName)?.init;
  const map = index?.type === "NewExpression" && index.callee.name === "Map" ? index.arguments[0] : null;
  const groups = member(map?.callee?.object, "projectGroups") ? map.callee.object.object : null;
  const mapper = map?.arguments[0];
  const linked = mapper?.body?.body?.find((node) => node.type === "VariableDeclaration")?.declarations[0]?.init;
  const key = mapper?.body?.body?.find((node) => node.type === "ReturnStatement")?.argument?.elements?.[0];
  if (!groups || !member(linked?.callee, "get") || key?.type !== "ConditionalExpression" ||
      key.consequent.type !== "CallExpression" || key.alternate.type !== "CallExpression") {
    throw new Error("Project sort: cannot resolve local/linked project keys");
  }
  const localKey = source(key.consequent.callee), cloudKey = source(key.alternate.callee);
  const links = source(linked.callee.object);
  const recency = new Set(nodes.filter(({ node }) => node.type === "Property" && node.key.name === "recencyAt" &&
    node.value.type === "CallExpression" && node.value.callee.type === "Identifier" && node.value.arguments[0]?.name === getter)
    .map(({ node }) => source(node.value.callee)));
  const projects = new Set(nodes.filter(({ node }) => node.type === "CallExpression" && member(node.callee, "map") &&
    node.arguments[0]?.params?.[0]?.type === "ObjectPattern" && property(node.arguments[0].params[0], "isPinned") &&
    property(node.arguments[0].params[0], "project") && textValue(property(node.arguments[0].body, "kind")?.value) === "project")
    .map(({ node }) => source(node.callee.object)));
  const chats = new Set(nodes.filter(({ node }) => member(node, "chatTargets")).map(({ node }) => source(node)));
  if (recency.size !== 1 || projects.size !== 1 || chats.size !== 1) throw new Error("Project sort: cannot resolve activity sources");

  // 新增局部变量统一使用独立前缀，避免遮蔽上游可能缩短为 e/t 的符号。
  if (source(selector).includes("__lx")) throw new Error("Project sort: injected identifier collision");
  const replacement = `/* ${MARKER}: 最近更新采用项目和会话最新活动；手动模式保留原顺序。 */(()=>{` +
    `const __lxMode=${mode},__lxRecency=new Map(${source(groups)}.projectGroups.map(__lxGroup=>{let __lxLinked=${links}.get(__lxGroup.projectId);return[__lxLinked==null?${localKey}(__lxGroup.projectId):${cloudKey}(__lxLinked),__lxGroup.threadKeys.reduce((__lxMax,__lxThread)=>Math.max(__lxMax,${[...recency][0]}(${getter},__lxThread)),Math.max(__lxGroup.projectUpdatedAt??0,__lxGroup.projectCreatedAt??0))]}));` +
    `${[...projects][0]}.forEach(({project:__lxProject})=>{let __lxKey=${cloudKey}(__lxProject.gizmo.id),__lxTime=Date.parse(__lxProject.gizmo.updated_at??__lxProject.gizmo.created_at??\`\`);__lxRecency.set(__lxKey,Math.max(__lxRecency.get(__lxKey)??0,Number.isFinite(__lxTime)?__lxTime:0))});` +
    `${[...chats][0]}.forEach(__lxChat=>{if(__lxChat.projectId!=null){let __lxKey=${cloudKey}(__lxChat.projectId);__lxRecency.set(__lxKey,Math.max(__lxRecency.get(__lxKey)??0,__lxChat.recencyAt??0))}});` +
    `return ${source(sort.callee.object)}.sort(__lxMode===\`manual\`?${source(compare)}:(__lxA,__lxB)=>(__lxRecency.get(__lxB.key)??0)-(__lxRecency.get(__lxA.key)??0)||(${source(compare)})(__lxA,__lxB))})()`;
  const edits = [{ start: sort.start, end: sort.end, value: replacement },
    { start: order.value.start, end: order.value.end, value: `${mode}===\`manual\`?${source(order.value)}:[]` }];
  let output = code;
  for (const edit of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, edit.start) + edit.value + output.slice(edit.end);
  // 落盘前检查完整输出，防止局部匹配成功却破坏 bundle 语法。
  acorn.parse(output, { ecmaVersion: "latest", sourceType: "module" });
  return { code: output, status: "patched" };
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((a) => ["mac-arm64", "mac-x64", "win"].includes(a));
  const bundles = locateBundles({ dir: "assets", pattern: /^app-(?:initial|main)-.*\.js$/, ...(platform ? { platform } : {}) });
  if (!bundles.length) throw new Error("Project sort: no sidebar bundle found; run sync-upstream first");
  for (const bundle of bundles) {
    const result = patchProjectSort(fs.readFileSync(bundle.path, "utf8"));
    if (result.status === "patched" && !args.includes("--check")) fs.writeFileSync(bundle.path, result.code, "utf8");
    console.log(`  [ok] ${relPath(bundle.path)}: ${result.status}${args.includes("--check") ? " (dry-run)" : ""}`);
  }
}

if (require.main === module) main();
module.exports = { patchProjectSort };
