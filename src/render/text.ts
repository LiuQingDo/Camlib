// 由 main.ts 拆分而来：仅做搬移，未改动逻辑。
import { LibraryAvailability, ScanRunDto } from "../api/infrastructure";
import {
  BackupPreviewDto,
  BackupRunDto,
  ConflictPolicy,
  DateFacetDto,
  MediaKind,
  PreviewMetaDto,
} from "../api/media";
import { state } from "../state";

export function formatDimensions(meta: PreviewMetaDto): string {
  if (meta.width && meta.height) return `${meta.width} × ${meta.height}`;
  return "尺寸未知";
}

export function fileRoleLabel(role: string): string {
  if (role === "live_photo") return "实况照片";
  if (role === "live_video") return "实况视频";
  return "主文件";
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character] ?? character,
  );
}

export function formatDate(date: string | null): string {
  if (!date) return "日期未知";
  const parts = date.split("-");
  return parts.length === 3 ? `${parts[0]}年${Number(parts[1])}月${Number(parts[2])}日` : date;
}

export function pathBaseName(value: string): string {
  const parts = value.split(/[/\\]/);
  return parts[parts.length - 1] || value;
}

export function conflictPolicyLabel(policy: ConflictPolicy): string {
  return policy === "rename" ? "自动重命名" : policy === "overwrite" ? "覆盖目标" : "跳过冲突";
}

export function backupStatusLabel(status: BackupRunDto["status"]): string {
  if (status === "completed") return "成功";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  if (status === "running") return "进行中";
  return "预览";
}

export function willCopyCount(preview: BackupPreviewDto): number {
  return preview.readyFiles + (preview.conflictPolicy === "skip_same" ? 0 : preview.conflictFiles);
}

export function kindLabel(kind: MediaKind): string {
  return kind === "photo" ? "照片" : kind === "video" ? "视频" : "实况";
}

export function selectedPrefix(prefix: string | undefined, value: string): string {
  return prefix === value ? "is-selected" : "";
}

export function facetTotal(): number {
  return state.facets.reduce((total, facet) => total + facet.count, 0);
}

export function scanRunStatusLabel(status: ScanRunDto["status"]): string {
  if (status === "completed") return "成功";
  if (status === "cancelled") return "已取消";
  if (status === "failed") return "失败";
  return "进行中";
}

export function libraryAvailabilityLabel(availability: LibraryAvailability): string {
  if (availability === "available") return "可用";
  if (availability === "disconnected") return "已断开";
  if (availability === "invalid") return "路径无效";
  return "未配置";
}

export function groupedFacets(): Array<{
  year: string;
  count: number;
  months: Array<{ month: string; count: number; dates: DateFacetDto[] }>;
}> {
  const years = new Map<string, { count: number; months: Map<string, { count: number; dates: DateFacetDto[] }> }>();
  for (const facet of state.facets) {
    const [year, month] = facet.date.split("-");
    if (!year || !month) continue;
    const yearGroup = years.get(year) ?? { count: 0, months: new Map() };
    const monthGroup = yearGroup.months.get(month) ?? { count: 0, dates: [] };
    yearGroup.count += facet.count;
    monthGroup.count += facet.count;
    monthGroup.dates.push(facet);
    yearGroup.months.set(month, monthGroup);
    years.set(year, yearGroup);
  }
  return [...years.entries()]
    .sort(([left], [right]) => right.localeCompare(left))
    .map(([year, value]) => ({
      year,
      count: value.count,
      months: [...value.months.entries()]
        .sort(([left], [right]) => right.localeCompare(left))
        .map(([month, monthValue]) => ({
          month,
          count: monthValue.count,
          dates: [...monthValue.dates].sort((left, right) => right.date.localeCompare(left.date)),
        })),
    }));
}
