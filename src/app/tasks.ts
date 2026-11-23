/**
 * 任务注册表 —— 「任务胶囊」通道的数据源。
 *
 * 纯数据，不碰 DOM。谁在跑（扫描 / 删除 / 以后的后台作业）就登记一条，
 * 跑完 finishTask 撤掉。胶囊只管展示与取消，不参与错误呈递。
 */
export interface Task {
  id: string;
  title: string;
  detail?: string;
  done?: number;
  total?: number;
  cancel?: () => void;
}

const tasks: Task[] = [];

/** 新增或就地更新（同 id 合并，保留插入位置，先跑的排前面）。 */
export function upsertTask(task: Task): void {
  const index = tasks.findIndex((entry) => entry.id === task.id);
  if (index >= 0) {
    tasks[index] = { ...tasks[index], ...task };
    return;
  }
  tasks.push(task);
}

export function finishTask(id: string): boolean {
  const index = tasks.findIndex((entry) => entry.id === id);
  if (index < 0) return false;
  tasks.splice(index, 1);
  return true;
}

export function listTasks(): Task[] {
  return tasks.slice();
}

/** 取消：先调任务自己的 cancel，再撤掉这条登记。 */
export function cancelTask(id: string): void {
  const task = tasks.find((entry) => entry.id === id);
  task?.cancel?.();
  finishTask(id);
}

/** 完成百分比；没有总数（发现阶段）时返回 null，由 UI 走不定进度。 */
export function taskPercent(task: Pick<Task, "done" | "total">): number | null {
  if (!task.total || task.total <= 0) return null;
  return Math.min(100, Math.max(0, Math.round(((task.done ?? 0) / task.total) * 100)));
}

/** 单测用。 */
export function resetTasksForTest(): void {
  tasks.length = 0;
}
