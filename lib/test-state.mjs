// In-memory Git mock: this is control-flow evidence, never real inference.
export function mockGit(state, writes = []) {
  let tree;
  return {
    getRef: async () => ({ data: { object: { sha: "head" } } }),
    getCommit: async () => ({ data: { tree: { sha: "base" } } }),
    createTree: async (args) => {
      tree = args.tree;
      return { data: { sha: "tree" } };
    },
    createCommit: async () => ({ data: { sha: "commit" } }),
    updateRef: async () => {
      for (const file of tree) {
        state[file.path] = JSON.parse(file.content);
        writes.push(file.path);
      }
    },
  };
}
