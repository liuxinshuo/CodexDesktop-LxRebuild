#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const acorn = require("acorn");
const { SRC_DIR, relPath } = require("./patch-util");

const MARKER = "lx-sidebar-pagination-v1";
const RECENTS_LABEL = "sidebarElectron.chatGptWork.recents";
const PARSE = { ecmaVersion: "latest", sourceType: "module" };
const ID = "[\\w$]+";
const COMPONENT = new RegExp(`function ${ID}\\(${ID}\\)\\{[^{}]{0,800}\\{[^{}]{0,400}\\bcatalogPageScope:`, "g");

const member = (node, name) => node?.type === "MemberExpression" && !node.computed && node.property.name === name;
const property = (node, name) => node?.properties?.find((p) => (p.key?.name ?? p.key?.value) === name)?.value;
const literal = (node) => node?.type === "Literal" ? node.value :
  node?.type === "TemplateLiteral" && !node.expressions.length ? node.quasis[0].value.cooked : undefined;

function collect(node, list = []) {
  if (!node?.type) return list;
  list.push(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => collect(child, list));
    else if (typeof value === "object") collect(value, list);
  }
  return list;
}

function one(matches, what) {
  if (matches.length !== 1) throw new Error(`Sidebar pagination: expected one ${what}, found ${matches.length}; upstream review required`);
  return matches[0];
}

// 统计已发布的原始候选，跳过筛选后不可见的记录，并在读不到新候选时退出。
async function fillRecentCatalog(reader, scope, limit, visibleCount, cancelled) {
  if (!reader || !scope) return;
  await Promise.all([reader.ensurePage(scope, Math.max(10, limit)), reader.waitForInitialMaterialization()]);
  const scopes = [scope, ...(scope.materializationScopes ?? [])];
  const loadedCount = () => scopes.reduce((total, page) => total + (reader.getEntries(page)?.length ?? 0), 0);
  while (!cancelled() && visibleCount() < limit && reader.getPageState(scope).hasMore) {
    const before = loadedCount();
    await reader.loadMore(scope, Math.max(10, limit - visibleCount()));
    if (loadedCount() <= before) break;
  }
}

function patchSidebarPagination(code) {
  if (code.includes(`/* ${MARKER} */`)) return { code, status: "already-patched" };
  const source = (node) => node && code.slice(node.start, node.end);
  const component = one([...code.matchAll(COMPONENT)].map(({ index }) => acorn.parseExpressionAt(code, index, PARSE))
    .filter((node) => source(node).includes(RECENTS_LABEL)), "unified sidebar component");
  const nodes = collect(component.body);
  const objects = nodes.filter((node) => node.type === "ObjectExpression");
  const calls = nodes.filter((node) => node.type === "CallExpression");
  const variables = nodes.filter((node) => node.type === "VariableDeclarator");
  const edits = [];
  const replace = (node, value) => edits.push({ start: node.start, end: node.end, value });
  const insert = (at, value) => edits.push({ start: at, end: at, value });
  const append = (node, value) => insert(node.properties.at(-1).end, `,${value}`);

  function findSection(sectionKey, listKey) {
    const section = one(objects.filter((node) => literal(property(node, "sectionKey")) === sectionKey &&
      property(node, "onCollapsedChange") && collect(property(node, "children")).some((child) => member(property(child, "keys"), listKey))), `${sectionKey} section`);
    const list = one(collect(property(section, "children")).filter((node) => member(property(node, "keys"), listKey)), `${sectionKey} list`);
    return { section, list, keys: source(property(list, "keys")), collapsed: source(property(section, "collapsed")) };
  }
  const project = findSection("threads", "projectKeys");
  const chats = findSection("chats", "chatKeys");
  const oldMore = property(chats.list, "hasMoreItems");
  const oldLoader = property(chats.list, "onLoadMore");
  const oldLoadOptions = oldLoader?.body?.arguments?.[0];
  const reader = source(property(oldLoadOptions, "catalogReader"));
  const scope = source(property(oldLoadOptions, "pageScope"));
  const cloud = property(oldLoadOptions, "fetchNextConversationPage")?.object;
  const hasCloud = source(property(oldLoadOptions, "canFetchNextConversationPage"));
  const fetchCloud = source(property(oldLoadOptions, "fetchNextConversationPage"));
  const scopeDecl = one(variables.filter(({ id }) => property(id, "layout") && property(id, "conversationByKey")), "sidebar layout selector result");
  const query = one(variables.filter(({ id }) => source(id) === source(scopeDecl.init)), "sidebar layout selector").init;
  const react = one([...new Set(calls.flatMap(({ callee }) => {
    const target = callee.type === "SequenceExpression" ? callee.expressions.at(-1) : callee;
    return member(target, "useState") ? [source(target.object)] : [];
  }))], "React hooks binding");

  const collapseHandler = property(chats.section, "onCollapsedChange");
  const callbacks = collapseHandler.type === "Identifier" ? nodes.filter((node) =>
    node.type === "AssignmentExpression" && node.left.name === collapseHandler.name).map(({ right }) => right) : [collapseHandler];
  const collapse = one(callbacks.flatMap((callback) => collect(callback).filter((node) => node.type === "CallExpression" &&
    literal(node.arguments[1]) === "chats" && node.arguments[2]?.name === callback.params?.[0]?.name)), "recents collapse setter");
  const store = source(collapse.arguments[0]);
  const unread = oldMore?.type === "ConditionalExpression" && source(oldMore.test);
  if (!project.collapsed || !chats.collapsed || !reader || !scope || !cloud || !hasCloud || !fetchCloud ||
      !member(property(oldLoadOptions, "fetchNextConversationPage"), "fetchNextConversationPage") || !unread ||
      query?.type !== "CallExpression" || query.arguments.length !== 2 || source(component).includes("__lx")) {
    throw new Error("Sidebar pagination: cannot resolve chat loading and section state; upstream review required");
  }

  // 在组件顶层创建状态，保留拖拽所用的完整键序列。
  insert(component.body.start + 1, `/* ${MARKER} */
    const __lxPageSize=5;
    const [__lxProjects,__lxSetProjects]=(0,${react}.useState)(__lxPageSize);
    const [__lxRecents,__lxSetRecents]=(0,${react}.useState)(__lxPageSize);
    const [__lxLoading,__lxSetLoading]=(0,${react}.useState)(false);
  `);
  const startsSection = (node, section) => node.start <= section.start && section.end <= node.end;
  const recentStatement = one(component.body.body.filter((node) => startsSection(node, chats.section)), "recents render statement");
  if (recentStatement.type !== "VariableDeclaration" || recentStatement.declarations[0].init?.arguments?.[1] !== chats.section ||
      !component.body.body.some((node) => node.type === "VariableDeclaration" && node.declarations.some(({ init }) => init?.arguments?.[1] === project.section))) {
    throw new Error("Sidebar pagination: section render moved into a memoized expression; upstream review required");
  }
  insert(recentStatement.start, `
    if(${project.collapsed}&&__lxProjects!==__lxPageSize)__lxSetProjects(__lxPageSize);
    if(${chats.collapsed}&&__lxRecents!==__lxPageSize)__lxSetRecents(__lxPageSize);
    const __lxFill=${fillRecentCatalog.toString()};
    const __lxVisible=()=>${store}.get(${query.arguments.map(source).join(",")}).layout.chatKeys.length;
    (0,${react}.useEffect)(()=>{
      if(${unread}||${chats.collapsed}||!${reader}||!${scope})return;
      let cancelled=false;
      __lxFill(${reader},${scope},__lxPageSize,__lxVisible,()=>cancelled).catch(()=>{});
      return()=>{cancelled=true};
    },[${unread},${chats.collapsed},${reader},${scope},${store},${source(query.arguments[1])}]);
  `);

  append(project.list, `expanded:false,forcedVisibleItemKey:void 0,revealAllOnExpand:false,onExpandedChange:void 0,
    maxItems:__lxProjects,paginationMode:"button",hasMoreItems:${project.keys}.length>__lxProjects,
    onLoadMore:async()=>{__lxSetProjects(limit=>limit+__lxPageSize)}`);
  append(chats.list, `...(${unread}?{}:{
    expanded:false,forcedVisibleItemKey:void 0,onExpandedChange:void 0,boundedLivePaging:false,
    maxItems:__lxRecents,paginationMode:"button",hasMoreItems:${chats.keys}.length>__lxRecents||(${source(oldMore.alternate)}),
    isLoadingMore:__lxLoading||${source(cloud)}.isFetchingNextConversationPage,
    onLoadMore:async()=>{
      if(__lxLoading)return;
      const loaded=${chats.keys}.length,next=Math.min(__lxRecents,loaded)+__lxPageSize;
      __lxSetRecents(next);
      if(next<=loaded)return;
      __lxSetLoading(true);
      try {
        await Promise.all([__lxFill(${reader},${scope},next,__lxVisible,()=>false),
          ${hasCloud}?${fetchCloud}(next-loaded):void 0]);
      } finally { __lxSetLoading(false); }
    }
  })`);

  // 键盘导航与项目内容的延迟显示都必须使用同一页边界。
  for (const [section, name, limit] of [[project, "projects", "__lxProjects"], [chats, "chats", "__lxRecents"]]) {
    const call = one(calls.filter(({ arguments: args }) => literal(args[0]) === name && source(args[1]) === section.keys), `${name} navigation list`);
    const keys = `${section.keys}.slice(0,${limit})`;
    replace(call.arguments[1], name === "chats" ? `${unread}?${section.keys}:${keys}` : keys);
  }
  const deferred = calls.filter((call) => member(call.callee, "filter") && source(call.callee.object) === project.keys && source(call).includes("showAllProjects"));
  if (deferred.length) replace(one(deferred, "visible project selector"), `${project.keys}.slice(0,__lxProjects)`);

  let output = code;
  for (const { start, end, value } of edits.sort((a, b) => b.start - a.start)) output = output.slice(0, start) + value + output.slice(end);
  acorn.parse(output, PARSE);
  return { code: output, status: "patched" };
}

function main() {
  const args = process.argv.slice(2);
  const platform = args.find((arg) => !arg.startsWith("--"));
  if (platform && platform !== "win") return;
  const dir = path.join(SRC_DIR, "win", "_asar", "webview", "assets");
  if (!platform && !fs.existsSync(dir)) return;
  const targets = [];
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    const file = path.join(entry.parentPath, entry.name);
    const code = fs.readFileSync(file, "utf8");
    if (code.includes(RECENTS_LABEL) && code.includes("catalogPageScope:")) targets.push({ file, code });
  }
  const { file, code } = one(targets, "Windows sidebar bundle");
  const result = patchSidebarPagination(code);
  if (result.status === "patched" && !args.includes("--check")) fs.writeFileSync(file, result.code, "utf8");
  console.log(`  [ok] ${relPath(file)}: ${result.status}${args.includes("--check") ? " (dry-run)" : ""}`);
}

if (require.main === module) main();
module.exports = { patchSidebarPagination, fillRecentCatalog };
