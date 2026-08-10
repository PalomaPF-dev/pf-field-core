import { afterEach, describe, expect, it, vi } from "vitest";
import { isUuid, uuid } from "../src/shared/uuid.js";
import { createEmitter } from "../src/shared/emitter.js";
import { createManualClock, now, setClock } from "../src/shared/clock.js";
import { createLogger, noopLogger } from "../src/shared/logger.js";
import { FieldCoreError, isFieldCoreError, NotImplementedError } from "../src/shared/errors.js";

describe("uuid", () => {
  it("UUID v4 の形式で返る", () => {
    const v = uuid();
    expect(isUuid(v)).toBe(true);
    expect(v[14]).toBe("4");
  });

  it("重複しない", () => {
    const set = new Set(Array.from({ length: 5_000 }, () => uuid()));
    expect(set.size).toBe(5_000);
  });

  it("randomUUID が無くても getRandomValues で組み立てる", () => {
    const real = globalThis.crypto;
    // randomUUID だけを取り除いた crypto に差し替える
    const stub = {
      getRandomValues: real.getRandomValues.bind(real),
    } as unknown as Crypto;
    vi.stubGlobal("crypto", stub);
    try {
      const v = uuid();
      expect(isUuid(v)).toBe(true);
      // version と variant のビットが正しく立っていること
      expect(v[14]).toBe("4");
      expect(["8", "9", "a", "b"]).toContain(v[19]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("暗号乱数が無い環境では黙って弱い乱数に落ちず、明示的に失敗する", () => {
    // 冪等キーに Math.random を使うとジョブIDが衝突しうる。落ちるほうが正しい
    vi.stubGlobal("crypto", undefined);
    try {
      expect(() => uuid()).toThrow(FieldCoreError);
      expect(() => uuid()).toThrow(/secure context/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("createEmitter", () => {
  it("購読・通知・解除ができる", () => {
    const emitter = createEmitter<{ tick: number }>();
    const seen: number[] = [];
    const off = emitter.on("tick", (n) => seen.push(n));

    emitter.emit("tick", 1);
    emitter.emit("tick", 2);
    off();
    emitter.emit("tick", 3);

    expect(seen).toEqual([1, 2]);
    expect(emitter.listenerCount("tick")).toBe(0);
  });

  it("once は1回だけ呼ばれる", () => {
    const emitter = createEmitter<{ tick: number }>();
    const seen: number[] = [];
    emitter.once("tick", (n) => seen.push(n));
    emitter.emit("tick", 1);
    emitter.emit("tick", 2);
    expect(seen).toEqual([1]);
  });

  it("あるリスナが例外を投げても他のリスナは呼ばれる", () => {
    const errors: unknown[] = [];
    const emitter = createEmitter<{ tick: number }>({
      onListenerError: (e) => errors.push(e),
    });
    const seen: number[] = [];
    emitter.on("tick", () => {
      throw new Error("壊れたリスナ");
    });
    emitter.on("tick", (n) => seen.push(n));

    emitter.emit("tick", 1);

    expect(seen).toEqual([1]);
    expect(errors).toHaveLength(1);
  });

  it("通知中に購読解除されても走査が壊れない", () => {
    const emitter = createEmitter<{ tick: number }>();
    const seen: string[] = [];
    const offB = emitter.on("tick", () => seen.push("b"));
    emitter.on("tick", () => {
      seen.push("a");
      offB();
    });
    emitter.emit("tick", 1);
    // スナップショットを取っているので、この回の b は呼ばれる
    expect(seen).toContain("a");
  });
});

describe("clock", () => {
  afterEach(() => {
    setClock({ now: () => Date.now() });
  });

  it("差し替えた時計が使われる", () => {
    const manual = createManualClock(1_000);
    const restore = setClock(manual);
    expect(now()).toBe(1_000);
    manual.advance(500);
    expect(now()).toBe(1_500);
    restore();
    expect(now()).toBeGreaterThan(1_500);
  });
});

describe("logger", () => {
  it("しきい値未満は出力しない", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const logger = createLogger("warn");
    logger.debug("出ないはず");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("しきい値以上は出力する", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    createLogger("warn").warn("出るはず", { jobId: "x" });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toContain("[pf-field-core]");
    spy.mockRestore();
  });

  it("silent は何も出さない", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    createLogger("silent").error("出ないはず");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("noopLogger は落ちない", () => {
    expect(() => noopLogger.error("x")).not.toThrow();
  });
});

describe("errors", () => {
  it("FieldCoreError は code を持ち、型ガードで判定できる", () => {
    const e = new FieldCoreError("invalid_argument", "だめ");
    expect(isFieldCoreError(e)).toBe(true);
    expect(e.code).toBe("invalid_argument");
    expect(isFieldCoreError(new Error("x"))).toBe(false);
  });

  it("NotImplementedError はマイルストーンを message に含める", () => {
    const e = new NotImplementedError("compressImage", "M1");
    expect(e.code).toBe("not_implemented");
    expect(e.message).toContain("M1");
  });
});
