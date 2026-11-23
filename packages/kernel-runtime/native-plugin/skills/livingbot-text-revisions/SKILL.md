---
name: livingbot-text-revisions
description: 对 Markdown、纯文本和源码中的唯一文本片段做精确修订，保留原件并交付独立新版本。DOCX 与 PDF 使用 local-office-documents；表格使用 local-office-tables。
---

# 精确文本修订

仅处理纯文本格式。先读取当前文件，将用户要求定位到唯一的原文片段；定位不唯一时补全相邻上下文，不能猜位置。

调用 livingbot_revise_document，传入从当前文件逐字读取的 anchor、replacement 和 expectedDigest。工具返回新的独立版本，原件保留。多处修改应沿上一版继续，不要回到最初版本重复覆盖。

重读结果，核对目标片段、相邻段落、编号、行尾和未指定区域；把实际新版本交付给用户。生成文件后使用 livingbot_deliver_file，不能把路径当作交付成功。

不处理 DOCX/PDF 的块、样式和批注，也不处理 XLSX 公式；这些任务读取对应 local-office 技能。不把扩展名变更当作格式转换，不因局部修改而重写全文。
