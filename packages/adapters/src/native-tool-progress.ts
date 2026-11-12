/** Public execution status only: never pass raw reasoning, commands or credentials. */
export function nativeToolProgress(name: string, phase: string, running = false): string | undefined {
  if (!["start", "result", "end"].includes(phase)) return;
  if (phase !== "start") return running ? "本机任务仍在运行，正在等待结果…" : "正在核对工具返回的结果…";
  switch (name.toLowerCase()) {
    case "memory_search": return "正在检索记忆…";
    case "memory_get": return "正在读取相关记忆…";
    case "read": return "正在读取文件…";
    case "find": case "grep": case "ls": return "正在查找相关资料…";
    case "shell": case "exec": return "正在执行本机任务…";
    case "process": return "正在检查本机任务进度…";
    case "web_search": case "web_fetch": return "正在查询网页资料…";
    default: return "正在调用工具…";
  }
}
