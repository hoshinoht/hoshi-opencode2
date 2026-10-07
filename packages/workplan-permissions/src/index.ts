import { Plugin } from "@opencode/plugin";
import { assertWorkplanPermission, GUARDED_TOOLS } from "./policy";

export default Plugin.define({
  id: "workplan-permissions",
  async setup(ctx) {
    const registration = await ctx.tool.transform((editor) => {
      for (const tool of editor.list()) {
        if (!tool.id.startsWith("workplan_")) continue;
        editor.update(tool.id, (entry) => {
          entry.options = { ...entry.options, codemode: true, pinned: true };
        });
      }
      for (const name of GUARDED_TOOLS) {
        editor.update(name, (tool) => {
          const execute = tool.execute;
          tool.execute = async (input, caller) => {
            assertWorkplanPermission(name, input, caller.agent);
            return execute(input, caller);
          };
        });
      }
    });
    return () => registration.dispose();
  },
});
