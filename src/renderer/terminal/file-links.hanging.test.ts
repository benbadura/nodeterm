// @vitest-environment jsdom
// Hanging-indent wraps: an agent TUI (Codex) wraps its own reply at a word boundary or after a `/`
// and indents the continuation under the bullet. Nothing in the buffer marks that — no wrapped
// flag, the row is not full, the next row starts with blanks — so neither half of a path wrapped
// that way linked. The seam is offered as extra READINGS, tried before the plain paragraph, and
// existence decides.
import { describe, expect, it } from "vitest";
import type { ILink, Terminal } from "@xterm/xterm";
import {
  createFileLinkProvider,
  installLinkClickFallback,
  installLinkContextMenu,
  linkAtCell,
  type LinkHit,
  type LinkHitDeps,
} from "./file-links";

const CELL_W = 10;
const CELL_H = 20;
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/u;

interface FakeCell {
  chars: string;
  width: number;
}

function toCells(row: string, cols: number): FakeCell[] {
  const out: FakeCell[] = [];
  for (const ch of row) {
    if (WIDE.test(ch))
      out.push({ chars: ch, width: 2 }, { chars: "", width: 0 });
    else out.push({ chars: ch, width: 1 });
  }
  while (out.length < cols) out.push({ chars: "", width: 1 });
  return out.slice(0, cols);
}

/** A terminal whose buffer answers per cell (getChars/getWidth), plus the DOM the listeners use. */
function fakeTerm(rows: string[], cols = 40) {
  const cellRows = rows.map((r) => toCells(r, cols));
  const host = document.createElement("div");
  const screen = document.createElement("div");
  screen.className = "xterm-screen";
  screen.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: cols * CELL_W,
      height: rows.length * CELL_H,
    }) as DOMRect;
  host.appendChild(screen);
  document.body.appendChild(host);
  const term = {
    cols,
    rows: rows.length,
    element: host,
    modes: { mouseTrackingMode: "vt200" },
    clearSelection: () => {},
    buffer: {
      active: {
        viewportY: 0,
        length: rows.length,
        getLine: (r: number) => {
          const cells = cellRows[r];
          if (!cells) return undefined;
          const str = cells
            .filter((c) => c.width !== 0)
            .map((c) => c.chars || " ")
            .join("");
          return {
            isWrapped: false,
            length: cols,
            translateToString: (trim: boolean) =>
              trim ? str.replace(/ +$/, "") : str,
            getCell: (x: number) => {
              const c = cells[x];
              return c && { getChars: () => c.chars, getWidth: () => c.width };
            },
          };
        },
      },
    },
    _core: { _oscLinkService: { getLinkData: () => undefined } },
  } as unknown as Terminal;
  return { term, host, screen };
}

const deps = (over: Partial<LinkHitDeps> = {}): LinkHitDeps => ({
  getCwd: () => "/home/me/proj",
  convention: () => ({}),
  fileEnabled: () => true,
  ...over,
});

type Fs = Record<string, "file" | "dir">;

const provide = (term: Terminal, row: number, fs: Fs): Promise<ILink[]> =>
  new Promise((resolve) => {
    createFileLinkProvider(term, {
      getCwd: () => "/home/me/proj",
      lookup: async (abs) => ({ exists: abs in fs, dir: fs[abs] === "dir" }),
      activate: () => {},
    }).provideLinks(row, (links) => resolve(links ?? []));
  });

function fire(
  target: HTMLElement,
  type: string,
  row: number,
  col: number,
  button: number,
  mod = false,
) {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button,
    metaKey: mod,
    clientX: col * CELL_W + 2,
    clientY: row * CELL_H + 2,
  });
  target.dispatchEvent(ev);
  return ev;
}
const settle = () => new Promise((r) => setTimeout(r, 0));

const clickOpens = async (
  rows: string[],
  cols: number,
  fs: Fs,
  row: number,
  col: number,
) => {
  const { term, host, screen } = fakeTerm(rows, cols);
  const opened: string[] = [];
  installLinkClickFallback(term, host, {
    ...deps(),
    lookup: async (abs) => ({ exists: abs in fs, dir: fs[abs] === "dir" }),
    activateFile: (abs) => opened.push(abs),
    openUrl: () => {},
  });
  const ev = fire(screen, "mouseup", row, col, 0, true);
  await settle();
  return { opened, swallowed: ev.defaultPrevented };
};

describe("a path the agent wrapped onto an indented row (the Codex report)", () => {
  // Measured shape, shortened to 62 columns: the break came after a `/`, with a 2-space hanging
  // indent, and the path has a space in it.
  const COLS = 62;
  const rows = [
    "• The file is at /Users/me/Claude/Claude Code/demo/feature-x/",
    "  docs/gui-proposal/TEAM-ACCESS.md",
  ];
  const FILE =
    "/Users/me/Claude/Claude Code/demo/feature-x/docs/gui-proposal/TEAM-ACCESS.md";
  const fs: Fs = {
    [FILE]: "file",
    // The first row names a real directory on its own — it must not win over the file.
    "/Users/me/Claude/Claude Code/demo/feature-x/": "dir",
    "/Users/me/Claude/Claude Code/demo/feature-x": "dir",
  };

  it("the rows really are not a soft or hard wrap", () => {
    expect(rows[0].length).toBeLessThan(COLS);
    expect(
      rows[0].length + 1 + "docs/gui-proposal/TEAM-ACCESS.md".length,
    ).toBeGreaterThan(COLS);
  });

  it("hovering either row links the whole file, across both rows", async () => {
    const { term } = fakeTerm(rows, COLS);
    for (const row of [1, 2]) {
      const links = await provide(term, row, fs);
      expect(links.map((l) => [l.text, l.range])).toEqual([
        [
          "/Users/me/Claude/Claude Code/demo/feature-x/docs/gui-proposal/TEAM-ACCESS.md",
          { start: { x: 18, y: 1 }, end: { x: 34, y: 2 } },
        ],
      ]);
    }
  });

  it("Cmd+click on either half opens the file", async () => {
    for (const [row, col] of [
      [0, 20],
      [0, 40],
      [1, 5],
    ] as const) {
      expect((await clickOpens(rows, COLS, fs, row, col)).opened).toEqual([
        FILE,
      ]);
    }
  });

  it("the right-click hit names the joined path first", () => {
    const { term } = fakeTerm(rows, COLS);
    const hit = linkAtCell(term, 1, 5, deps()) as Extract<
      LinkHit,
      { kind: "path" }
    >;
    expect(hit.token).toBe(FILE);
    // The plain row's own reading is still there to fall back on.
    expect(hit.alternatives).toContain("docs/gui-proposal/TEAM-ACCESS.md");
  });

  it("a click on the indent is not a click on the path", async () => {
    const { term } = fakeTerm(rows, COLS);
    expect(linkAtCell(term, 1, 0, deps())).toBeNull();
    expect((await clickOpens(rows, COLS, fs, 1, 1)).swallowed).toBe(false);
  });
});

describe("a wrap that ate a space", () => {
  const COLS = 40;
  const rows = ["• see /data/My", "  Documents/notes.md for it"];
  // `/data/My` fits on row 0 (14 cells); the wrapper broke because `Documents/notes.md` did not.
  const rowsAtWidth = ["• see /data/My Big", "  Documents/notes.md for it"];

  it("links the spaced path when that is what exists", async () => {
    const { term } = fakeTerm(rowsAtWidth, 20);
    const links = await provide(term, 1, {
      "/data/My Big Documents/notes.md": "file",
    });
    expect(links.map((l) => l.text)).toEqual([
      "/data/My Big Documents/notes.md",
    ]);
  });

  it("does not join after a short line: an indented list is not a wrap", async () => {
    const { term } = fakeTerm(rows, COLS);
    const links = await provide(term, 1, {
      "/data/MyDocuments/notes.md": "file",
      "/data/My Documents/notes.md": "file",
      "/data/My": "dir",
    });
    expect(links.map((l) => l.text)).toEqual(["/data/My"]);
  });
});

describe("what stays exactly as it was", () => {
  it("a path on one row with nothing indented after it", async () => {
    const { term } = fakeTerm(["open src/a.ts now", "next line"], 40);
    const links = await provide(term, 1, { "/home/me/proj/src/a.ts": "file" });
    expect(links.map((l) => l.text)).toEqual(["src/a.ts"]);
    expect(linkAtCell(term, 0, 6, deps())).toEqual({
      kind: "path",
      token: "src/a.ts",
      abs: "/home/me/proj/src/a.ts",
    });
  });

  it("a joined reading that does not exist costs the plain links nothing", async () => {
    const rows = ["• edited /tmp/one/two.ts and then", "  src/b.ts next"];
    const { term } = fakeTerm(rows, 36);
    const links = await provide(term, 1, {
      "/tmp/one/two.ts": "file",
      "/home/me/proj/src/b.ts": "file",
    });
    expect(links.map((l) => l.text)).toEqual(["/tmp/one/two.ts"]);
    const second = await provide(term, 2, {
      "/tmp/one/two.ts": "file",
      "/home/me/proj/src/b.ts": "file",
    });
    expect(second.map((l) => l.text)).toEqual(["src/b.ts"]);
  });

  it("a right-click under a hanging row still falls back to the row's own path", () => {
    const rows = ["• wrote /tmp/one/two/three.ts", "  and-more-words-here.txt"];
    const { term, host, screen } = fakeTerm(rows, 36);
    const opened: LinkHit[] = [];
    installLinkContextMenu(term, host, {
      ...deps(),
      openMenu: (hit) => opened.push(hit),
    });
    fire(screen, "mousedown", 0, 10, 2);
    fire(screen, "contextmenu", 0, 10, 2);
    expect(opened[0]).toMatchObject({ kind: "path" });
    expect(opened[0].kind === "path" && opened[0].alternatives).toContain(
      "/tmp/one/two/three.ts",
    );
  });
});
