// The MCP server owns no tool list: generation tools come from the gateway catalog, which follows
// the engines enabled in the console. Only gateway-level tools are known locally.
export {ID,COMMON_TOOLS,capabilityForTool,validateToolInput} from '../workbench/lib/media-tools.mjs';
