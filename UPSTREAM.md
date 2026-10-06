# Logseq 来源

- 仓库：https://github.com/logseq/logseq
- 本次获取提交：`e2ca31b906eb0005a5e2651dbf0274f1b8d02b47`
- 完整浅克隆位于工作区 `work/logseq`，已恢复 Windows 长路径导致的首次检出失败。
- 许可证：AGPL-3.0；随项目附上上游 `LICENSE.md`。
- 参考文件：`src/main/frontend/fs.cljs` 的平台文件操作边界，以及 `docs/adr/0016-markdown-mirror.md` 的原子写入和职责划分。

当前上游的 DB graph 以数据库为事实来源，Markdown Mirror 是派生输出。Diary 按需求以本地 Markdown 为事实来源，新增模块采用独立 TypeScript 实现，尚未接入 Logseq UI 或数据库运行时，也未复制其 ClojureScript 实现。
