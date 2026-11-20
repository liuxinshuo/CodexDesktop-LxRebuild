const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { patchSidebarPagination, fillRecentCatalog } = require("./patch-sidebar-pagination");

const fixture = `function sidebar(input){
  let {catalogPageScope:page, unreadsOnly:unread}=input;
  const [unused]=hooks.useState(null);
  const store={get:()=>model};
  const state=read(layoutSelector, options);
  const {layout: lists,conversationByKey: lookup}=state;
  const {reader,cloud,collapsed,projectCollapsed}=input;
  const chatLabel="sidebarElectron.chatGptWork.recents";
  const nav=[navigation(\`projects\`,lists.projectKeys),navigation("chats",lists.chatKeys)];
  let chats=jsx(section,{label:chatLabel,sectionKey:"chats",collapsed,onCollapsedChange:value=>save(store,"chats",value),children:[
    jsx(list,{keys:lists.chatKeys,forcedVisibleItemKey:"outside-page",maxItems:10,hasMoreItems:unread?false:input.hasMore,
      isLoadingMore:true,paginationMode:"infiniteScroll",onLoadMore:n=>load({catalogReader:reader,pageScope:page,pageSize:n,
        canFetchNextConversationPage:cloud.canFetchNextConversationPage,fetchNextConversationPage:cloud.fetchNextConversationPage})})
  ]});
  let projects=jsx(section,{sectionKey:\`threads\`,collapsed:projectCollapsed,onCollapsedChange:value=>save(store,"threads",value),children:[
    jsx(list,{keys:lists.projectKeys,maxItems:5,expanded:true,revealAllOnExpand:true})
  ]});
  return {chats:chats.children[0],projects:projects.children[0],nav};
}`;

test("projects and recents open at five, increase by five, and reset independently", async () => {
  const { code } = patchSidebarPagination(fixture);
  assert.deepEqual(patchSidebarPagination(code), { code, status: "already-patched" });
  assert.throws(() => patchSidebarPagination(fixture.replace("conversationByKey", "renamed")), /upstream review required/);

  const keys = Array.from({ length: 16 }, (_, index) => String(index));
  const state = [];
  let cursor = 0;
  const model = { layout: { projectKeys: keys, chatKeys: keys } };
  const hooks = {
    useState(initial) {
      const index = cursor++;
      state[index] ??= initial;
      return [state[index], (update) => { state[index] = typeof update === "function" ? update(state[index]) : update; }];
    },
    useEffect() {},
  };
  const sidebar = vm.runInNewContext(code + ";sidebar", {
    hooks, model, read: () => model, layoutSelector: null, options: null, section: null, list: null,
    jsx: (_, props) => props, navigation: (_, keys) => keys,
  });
  const render = (prefs = {}) => { cursor = 0; return sidebar({ cloud: {}, ...prefs }); };
  let { projects, chats, nav } = render();
  assert.equal(projects.keys, keys);
  assert.equal(chats.keys, keys);
  assert.equal(chats.forcedVisibleItemKey, undefined);
  assert.equal(Boolean(chats.isLoadingMore), false);
  assert.equal(chats.paginationMode, "button");
  assert.deepEqual(Array.from(nav, ({ length }) => length), [5, 5]);
  await projects.onLoadMore();
  await chats.onLoadMore();
  ({ projects, chats } = render());
  assert.deepEqual([projects.maxItems, chats.maxItems], [10, 10]);
  render({ collapsed: true });
  ({ projects, chats } = render());
  assert.deepEqual([projects.maxItems, chats.maxItems], [10, 5]);
  render({ projectCollapsed: true });
  assert.equal(render().projects.maxItems, 5);
  assert.equal(render({ unreadsOnly: true }).chats.paginationMode, "infiniteScroll");
});

test("recents publish deferred results and advance across filtered pages", async () => {
  const rows = Array.from({ length: 17 }, (_, index) => index < 2 || index >= 12);
  let cached = rows.slice(0, 2);
  let fetched = cached;
  let reads = 0;
  const reader = {
    async ensurePage() { fetched = rows.slice(0, 10); },
    async waitForInitialMaterialization() { cached = fetched; },
    getEntries: () => cached,
    getPageState: () => ({ hasMore: true }),
    async loadMore(_, count) { reads++; cached = rows.slice(0, cached.length + count); },
  };
  const visibleCount = () => cached.filter(Boolean).length;
  assert.equal(visibleCount(), 2);
  await fillRecentCatalog(reader, { key: "recents" }, 5, visibleCount, () => false);
  assert.equal(Math.min(5, visibleCount()), 5);
  await fillRecentCatalog(reader, { key: "recents" }, 10, visibleCount, () => false);
  assert.equal(visibleCount(), 7);
  assert.equal(reads, 3, "stop when the source stops advancing");
});
