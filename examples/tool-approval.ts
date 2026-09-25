import { createAgent, defineTool, z } from "@ad17-2/agent";
import { scripted, text, toolCall } from "./mock-model.ts";

const deleteFile = defineTool({
  description: "Delete a file",
  schema: z.object({ path: z.string() }),
  handler: async ({ path }) => `deleted ${path}`,
});

const agent = createAgent({
  model: scripted([toolCall("deleteFile", { path: "/tmp/build.log" }), text("Removed it.")]),
  systemPrompt: "You tidy up the workspace.",
  tools: { deleteFile },
  toolApproval: { deleteFile: "user-approval" },
});

// The run stops before the gated tool runs and reports what it wants to do.
const request = await agent.run("Delete the build log");
console.log("stopReason:", request.stopReason);
console.log("pendingApprovals:", request.pendingApprovals);

// A human decides; the same ids come back from agent.pendingApprovals() after export/import too.
const approvals = agent
  .pendingApprovals()
  .map(({ approvalId }) => ({ approvalId, approved: true, reason: "logs are disposable" }));

// The resume runs the approved tool, then the model finishes its answer.
const result = await agent.run({ approvals });
console.log("toolsCalled:", result.toolsCalled);
console.log("message:", result.message);
console.log("stopReason:", result.stopReason);
