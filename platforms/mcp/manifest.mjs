// The MCP server owns no tool list: generation tools come from the gateway catalog, which follows
// the engines enabled in the console. Only gateway-level tools are known locally.
export {ID,COMMON_TOOLS,LEGACY_TOOLS,INSTRUCTIONS,isGenerationTool,validateToolInput,listedTools,modelsView,BROWSE,CATEGORIES,TASK_TOOLS,categoriesOf,scopeMedia,categoryTools,visibleTools,browseResult} from '../workbench/lib/media-tools.mjs';
