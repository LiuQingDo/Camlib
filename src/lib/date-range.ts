/**
 * 筛选面板的日期预设：纯日期算术，不碰 DOM。
 *
 * 面板里只给「本周 / 本月 / 上月 / 今年 / 清除」五个预设 + 两个原生 date 输入，
 * 不自造日历：`input[type="date"]` 自带键盘输入、区域格式、可访问性与
 * Windows 原生选择器，自研日历只会把这三样都做差。
 */

/** 预设 id；`clear` 表示清空日期条件（不是区间）。 */
export type DatePresetId = "week" | "month" | "last-month" | "year" | "clear";

export interface DateRange {
  from: string;
  to: string;
}

/** 本地时区的 `YYYY-MM-DD`（不能用 toISOString：那是 UTC，会差一天）。 */
function isoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** 预设 → 具体区间；`clear` 与未知 id 返回 null。以本地时区的今天为基准。 */
export function presetRange(id: DatePresetId, today: Date = new Date()): DateRange | null {
  const year = today.getFullYear();
  const month = today.getMonth();
  switch (id) {
    case "week": {
      // 周一为一周之首：getDay() 里周日是 0，先转成 0=周一。
      const start = new Date(today);
      start.setDate(today.getDate() - ((today.getDay() + 6) % 7));
      return { from: isoDate(start), to: isoDate(today) };
    }
    case "month":
      return { from: isoDate(new Date(year, month, 1)), to: isoDate(today) };
    case "last-month": {
      const start = new Date(year, month - 1, 1);
      // 上个月的最后一天 = 本月第 0 天。
      const end = new Date(year, month, 0);
      return { from: isoDate(start), to: isoDate(end) };
    }
    case "year":
      return { from: isoDate(new Date(year, 0, 1)), to: isoDate(today) };
    default:
      return null;
  }
}

/** 当前区间正好等于某个预设时返回它，用于预设按钮的高亮。 */
export function matchDatePreset(
  from: string | undefined,
  to: string | undefined,
  today: Date = new Date(),
): DatePresetId | null {
  if (!from && !to) return null;
  for (const id of ["week", "month", "last-month", "year"] as const) {
    const range = presetRange(id, today);
    if (range && range.from === from && range.to === to) return id;
  }
  return null;
}
