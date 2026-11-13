import { describe, expect, it } from "vitest";
import source from "./main.ts?raw";

// 这段是装配层的静态守卫。拆分后有两类失效完全不会报错、只会让界面「画得出来
// 但点不动」，所以在这里钉死：
//   1. 从 render/paint 门面拿同名函数当实现注入 → 首次重绘自我递归爆栈；
//   2. 把带顶层副作用的模块漏掉 → 快捷键 / data-action 委托 / 后端进度流全丢。
describe("main.ts wiring", () => {
  it("imports only installPaint from the paint facade", () => {
    const match = /import \{([^}]+)\} from "\.\/render\/paint";/.exec(source);
    expect(match).not.toBeNull();
    expect(match![1].trim()).toBe("installPaint");
  });

  it("keeps the side-effect modules that register global listeners", () => {
    expect(source).toContain('import "./app/bindings/global";');
    expect(source).toContain('import "./render/events";');
  });
});
