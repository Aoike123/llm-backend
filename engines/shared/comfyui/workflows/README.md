# 工作流模板

`catalog.json` 登记 7 个 H3 模板、金鱼原版和 3 个 Anima 模板。`ui/` 存放画布文件，`api/` 存放同一模板的 API 图。Anima adapter 和金鱼工作流按模板 id 直接读取这里的 API 图。

`./lab comfyui sync` 把模板同步到画布工作流库；用户文件保留，改过的托管模板更新前先备份。清单与目录见 [ComfyUI 运行时](../../../../docs/COMFYUI.md#工作流模板)。
