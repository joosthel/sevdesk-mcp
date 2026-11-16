import { describe, expect, it } from "vitest";

import { SevdeskApiError } from "../src/client.js";
import type { ToolContext } from "../src/lib/tool.js";
import { tools } from "../src/server.js";
import { cleanupTools } from "../src/tools/cleanup.js";

type Row = Record<string, unknown>;
type Req = { method: string; path: string; query?: Row; body?: unknown; form?: FormData };

const tool = (name: string) => cleanupTools.find((t) => t.name === name)!;
const deleteVoucher = tool("sevdesk_delete_voucher");
const setPrivate = tool("sevdesk_set_transaction_private");
const upload = tool("sevdesk_upload_voucher_file_content");
const updateDraft = tool("sevdesk_update_draft_voucher");

/**
 * A tiny in-memory sevDesk: vouchers, their positions and bank transactions.
 * Writes change the state the way the live API does, so the tools' read-back
 * verification runs against real effects. Every mutating request is recorded.
 */
function fakeSevdesk(state: { vouchers?: Row[]; positions?: Row[]; transactions?: Row[] }, opts: { dryRun?: boolean; allowBooking?: boolean } = {}) {
  const vouchers = new Map((state.vouchers ?? []).map((v) => [String(v.id), v]));
  let positions = state.positions ?? [];
  const transactions = new Map((state.transactions ?? []).map((t) => [String(t.id), t]));
  const sent: Req[] = [];
  const notFound = (req: Req) => {
    throw new SevdeskApiError(404, req.method, req.path, { error: { message: "not found" } });
  };

  const client = {
    async request(req: Req) {
      if (req.method !== "GET") sent.push(req);
      let m: RegExpExecArray | null;
      if (req.method === "GET" && (m = /^\/Voucher\/(\d+)$/.exec(req.path))) {
        const v = vouchers.get(m[1]!);
        return v ? { status: 200, data: { objects: [v] } } : notFound(req);
      }
      if (req.method === "DELETE" && (m = /^\/Voucher\/(\d+)$/.exec(req.path))) {
        vouchers.delete(m[1]!);
        return { status: 200, data: { objects: [null] } };
      }
      if (req.method === "GET" && req.path === "/VoucherPos") {
        const id = String(req.query?.["voucher[id]"]);
        return { status: 200, data: { objects: positions.filter((p) => String((p.voucher as Row).id) === id) } };
      }
      if ((m = /^\/CheckAccountTransaction\/(\d+)$/.exec(req.path))) {
        const t = transactions.get(m[1]!);
        if (!t) return notFound(req);
        if (req.method === "PUT") Object.assign(t, req.body as Row);
        return { status: 200, data: { objects: [t] } };
      }
      if (req.path === "/Voucher/Factory/uploadTempFile") {
        return { status: 201, data: { objects: { filename: "abc123.pdf", pages: 1, content: "x".repeat(50_000) } } };
      }
      if (req.path === "/Voucher/Factory/saveVoucher") {
        const body = req.body as { voucher: Row; voucherPosSave: Row[]; voucherPosDelete: Row[] | null };
        const id = String(body.voucher.id);
        const v = vouchers.get(id)!;
        const deleted = new Set((body.voucherPosDelete ?? []).map((p) => String(p.id)));
        positions = positions.filter((p) => !(String((p.voucher as Row).id) === id));
        let net = 0;
        let gross = 0;
        body.voucherPosSave.forEach((p, i) => {
          if (deleted.has(String(p.id))) return;
          const rate = Number(p.taxRate);
          const n = p.net ? Number(p.sumNet) : Number(p.sumGross) / (1 + rate / 100);
          net += n;
          gross += n * (1 + rate / 100);
          positions.push({ id: p.id ?? `new${i}`, voucher: { id }, net: p.net, sumNet: n, taxRate: rate, sumTax: n * rate / 100, sumGross: n * (1 + rate / 100), accountDatev: p.accountDatev });
        });
        Object.assign(v, { status: String(body.voucher.status), voucherDate: body.voucher.voucherDate, description: body.voucher.description, sumNet: net, sumTax: gross - net, sumGross: gross });
        return { status: 200, data: { objects: { voucher: v } } };
      }
      if ((m = /^\/Voucher\/(\d+)\/bookAmount$/.exec(req.path))) {
        const v = vouchers.get(m[1]!)!;
        const body = req.body as Row;
        v.paidAmount = Number(v.paidAmount ?? 0) + Number(body.amount);
        if (body.type !== "N") v.status = "1000";
        transactions.get(String((body.checkAccountTransaction as Row).id))!.status = "200";
        return { status: 200, data: { objects: {} } };
      }
      throw new Error(`fake sevDesk: unexpected ${req.method} ${req.path}`);
    },
  };
  const clientWithAll = {
    ...client,
    async getAll(path: string, query: Row) {
      return ((await client.request({ method: "GET", path, query })).data as { objects: Row[] }).objects;
    },
  };
  const ctx = {
    client: clientWithAll,
    config: {
      baseUrl: "https://example.test/api/v1",
      readOnly: false,
      dryRun: opts.dryRun ?? false,
      allowBooking: opts.allowBooking ?? false,
      allowedReceiptDirs: [],
    },
    getProfile: async () => ({ regime: "regular", source: "env", evidence: "test stub", ledger: null }),
  } as unknown as ToolContext;
  return { ctx, sent, vouchers, transactions, positions: () => positions };
}

const draft = (extra: Row = {}): Row => ({
  id: "11",
  objectName: "Voucher",
  status: "50",
  voucherDate: "2026-09-01T00:00:00+02:00",
  supplierName: "Anthropic",
  description: "INV-1",
  creditDebit: "C",
  voucherType: "VOU",
  currency: "EUR",
  taxRule: { id: "9", objectName: "TaxRule" },
  sumNet: 214.2,
  sumTax: 0,
  sumGross: 214.2,
  paidAmount: 0,
  enshrined: null,
  document: { id: "900", objectName: "Document" },
  ...extra,
});

const draftPosition = { id: "21", voucher: { id: "11" }, net: "1", sumNet: 214.2, taxRate: 0, sumTax: 0, sumGross: 214.2, accountDatev: { id: "5000", objectName: "AccountDatev" } };

const openTx = (extra: Row = {}): Row => ({
  id: "31",
  status: "100",
  amount: -214.2,
  valueDate: "2026-09-03T00:00:00+02:00",
  payeePayerName: "ANTHROPIC PBC",
  paymtPurpose: "Claude subscription",
  checkAccount: { id: "41", objectName: "CheckAccount" },
  enshrined: null,
  ...extra,
});

describe("tool registration", () => {
  it("lists every cleanup tool as mutating; delete and private are booking tools, only delete destructive", () => {
    for (const t of cleanupTools) {
      expect(tools).toContain(t);
      expect(t.mutating).toBe(true);
      expect(t.inputSchema.properties).toHaveProperty("dryRun");
    }
    expect(cleanupTools.filter((t) => t.destructive).map((t) => t.name)).toEqual(["sevdesk_delete_voucher"]);
    expect(cleanupTools.filter((t) => t.booking).map((t) => t.name).sort()).toEqual([
      "sevdesk_delete_voucher",
      "sevdesk_set_transaction_private",
    ]);
  });
});

describe("sevdesk_delete_voucher", () => {
  it("deletes a draft and verifies it is gone", async () => {
    const s = fakeSevdesk({ vouchers: [draft()] });
    const out = (await deleteVoucher.handler({ voucherId: "11" }, s.ctx)) as Row;
    expect(out).toMatchObject({ deleted: true, verified: true, voucher: { supplier: "Anthropic", gross: 214.2 } });
    expect(s.vouchers.has("11")).toBe(false);
  });

  it("previews under dryRun without sending", async () => {
    const s = fakeSevdesk({ vouchers: [draft()] });
    const out = (await deleteVoucher.handler({ voucherId: "11", dryRun: true }, s.ctx)) as Row;
    expect(out.dryRun).toBe(true);
    expect(s.sent).toHaveLength(0);
  });

  it("honours the global dry-run flag", async () => {
    const s = fakeSevdesk({ vouchers: [draft()] }, { dryRun: true });
    await deleteVoucher.handler({ voucherId: "11" }, s.ctx);
    expect(s.sent).toHaveLength(0);
  });

  it.each([
    ["open", { status: "100" }, /only drafts/],
    ["paid", { status: "1000" }, /only drafts/],
    ["enshrined", { enshrined: "2026-01-01" }, /enshrined/],
    ["partly paid", { paidAmount: 10 }, /has payments/],
  ])("refuses a %s voucher", async (_label, extra, msg) => {
    const s = fakeSevdesk({ vouchers: [draft(extra)] });
    await expect(deleteVoucher.handler({ voucherId: "11" }, s.ctx)).rejects.toThrow(msg);
    expect(s.sent).toHaveLength(0);
  });

  it("refuses ids that are not numeric", async () => {
    const s = fakeSevdesk({});
    await expect(deleteVoucher.handler({ voucherId: "11/../x" }, s.ctx)).rejects.toThrow(/numeric/);
  });

  it("reports a missing voucher", async () => {
    const s = fakeSevdesk({});
    await expect(deleteVoucher.handler({ voucherId: "99" }, s.ctx)).rejects.toThrow(/No voucher/);
  });
});

describe("sevdesk_set_transaction_private", () => {
  it("sets an open transaction to 300 and verifies", async () => {
    const s = fakeSevdesk({ transactions: [openTx()] });
    const out = (await setPrivate.handler({ transactionId: "31" }, s.ctx)) as Row;
    expect(out).toMatchObject({ changed: true, verified: true });
    expect(s.sent[0]).toMatchObject({ method: "PUT", path: "/CheckAccountTransaction/31", body: { status: 300 } });
  });

  it("is a no-op on an already private transaction", async () => {
    const s = fakeSevdesk({ transactions: [openTx({ status: "300" })] });
    const out = (await setPrivate.handler({ transactionId: "31" }, s.ctx)) as Row;
    expect(out.changed).toBe(false);
    expect(s.sent).toHaveLength(0);
  });

  it.each([["linked", "200"], ["auto-booked", "350"], ["booked", "400"]])("refuses a %s transaction", async (_l, status) => {
    const s = fakeSevdesk({ transactions: [openTx({ status })] });
    await expect(setPrivate.handler({ transactionId: "31" }, s.ctx)).rejects.toThrow(/only open transactions/);
  });

  it("refuses an enshrined transaction", async () => {
    const s = fakeSevdesk({ transactions: [openTx({ enshrined: "2026-01-01" })] });
    await expect(setPrivate.handler({ transactionId: "31" }, s.ctx)).rejects.toThrow(/enshrined/);
  });
});

describe("sevdesk_upload_voucher_file_content", () => {
  const pdf = Buffer.from("%PDF-1.4\n%test\n").toString("base64");

  it("uploads and returns only the token, not sevDesk's preview blob", async () => {
    const s = fakeSevdesk({});
    const out = (await upload.handler({ fileName: "invoice.pdf", base64Content: pdf }, s.ctx)) as Row;
    expect(out.fileName).toBe("abc123.pdf");
    expect(JSON.stringify(out).length).toBeLessThan(2000);
    const file = (s.sent[0]!.form as FormData).get("file") as File;
    expect(file.name).toBe("invoice.pdf");
    expect(file.type).toBe("application/pdf");
  });

  it("accepts data: URLs and URL-safe base64", async () => {
    const s = fakeSevdesk({});
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xfb, 0xff]);
    const urlSafe = png.toString("base64url");
    const out = (await upload.handler({ fileName: "r.png", base64Content: `data:image/png;base64,${urlSafe}`, dryRun: true }, s.ctx)) as Row;
    expect(out).toMatchObject({ dryRun: true, file: { mimeType: "image/png", bytes: 10 } });
  });

  it("refuses content that does not match the extension", async () => {
    const s = fakeSevdesk({});
    await expect(upload.handler({ fileName: "r.png", base64Content: pdf }, s.ctx)).rejects.toThrow(/application\/pdf.*\.png/);
  });

  it("refuses unknown file types and broken base64", async () => {
    const s = fakeSevdesk({});
    await expect(upload.handler({ fileName: "r.exe", base64Content: pdf }, s.ctx)).rejects.toThrow(/must end in/);
    await expect(upload.handler({ fileName: "r.pdf", base64Content: "%%%" }, s.ctx)).rejects.toThrow(/not valid base64/);
    const exe = Buffer.from("MZ\x90\x00").toString("base64");
    await expect(upload.handler({ fileName: "r.pdf", base64Content: exe }, s.ctx)).rejects.toThrow(/not a PDF/);
    expect(s.sent).toHaveLength(0);
  });

  it("refuses files above 10 MB before decoding", async () => {
    const s = fakeSevdesk({});
    const big = "A".repeat(Math.ceil((10 * 1024 * 1024 * 4) / 3) + 16);
    await expect(upload.handler({ fileName: "r.pdf", base64Content: big }, s.ctx)).rejects.toThrow(/larger than/);
  });
});

describe("sevdesk_update_draft_voucher", () => {
  it("fixes a 0 % voucher to net 180 + 19 % and keeps id, booking account and file", async () => {
    const s = fakeSevdesk({ vouchers: [draft()], positions: [{ ...draftPosition }] });
    const out = (await updateDraft.handler({ voucherId: "11", positions: [{ sumNet: 180, taxRate: 19 }] }, s.ctx)) as Row;
    expect(out).toMatchObject({ changed: true, verified: true, after: { net: 180, tax: 34.2, gross: 214.2, hasFile: true } });
    const body = s.sent[0]!.body as { voucherPosSave: Row[] };
    expect(body.voucherPosSave[0]).toMatchObject({ id: 21, accountDatev: { id: 5000 }, sumNet: 180, net: true });
  });

  it("deletes surplus old positions", async () => {
    const second = { ...draftPosition, id: "22", sumNet: 0 };
    const s = fakeSevdesk({ vouchers: [draft()], positions: [{ ...draftPosition }, second] });
    await updateDraft.handler({ voucherId: "11", positions: [{ sumGross: 214.2, taxRate: 19 }], dryRun: true }, s.ctx);
    const out = (await updateDraft.handler({ voucherId: "11", positions: [{ sumGross: 214.2, taxRate: 19 }] }, s.ctx)) as Row;
    expect((s.sent[0]!.body as Row).voucherPosDelete).toEqual([{ id: 22, objectName: "VoucherPos" }]);
    expect(out.verified).toBe(true);
  });

  it("refuses a rate the tax rule does not allow", async () => {
    const s = fakeSevdesk({ vouchers: [draft()], positions: [{ ...draftPosition }] });
    await expect(updateDraft.handler({ voucherId: "11", positions: [{ sumNet: 180, taxRate: 16 }] }, s.ctx)).rejects.toThrow(/allows only/);
  });

  it("refuses mixing sumNet and sumGross", async () => {
    const s = fakeSevdesk({ vouchers: [draft()], positions: [{ ...draftPosition }] });
    await expect(
      updateDraft.handler({ voucherId: "11", positions: [{ sumNet: 100, taxRate: 19 }, { sumGross: 50, taxRate: 19 }] }, s.ctx),
    ).rejects.toThrow(/same one/);
  });

  it("finalizes to open (100)", async () => {
    const s = fakeSevdesk({ vouchers: [draft()], positions: [{ ...draftPosition }] }, { allowBooking: true });
    const out = (await updateDraft.handler({ voucherId: "11", finalize: true }, s.ctx)) as Row;
    expect(out).toMatchObject({ verified: true, after: { status: "100 offen" } });
  });

  it("refuses to finalize when a position has no booking account", async () => {
    const s = fakeSevdesk({ vouchers: [draft()], positions: [{ ...draftPosition, accountDatev: null }] }, { allowBooking: true });
    await expect(updateDraft.handler({ voucherId: "11", finalize: true }, s.ctx)).rejects.toThrow(/no booking account/);
    expect(s.sent).toHaveLength(0);
  });

  it("refuses open and enshrined vouchers, and empty changes", async () => {
    let s = fakeSevdesk({ vouchers: [draft({ status: "100" })] });
    await expect(updateDraft.handler({ voucherId: "11", description: "x" }, s.ctx)).rejects.toThrow(/only drafts/);
    s = fakeSevdesk({ vouchers: [draft({ enshrined: "2026-01-01" })] });
    await expect(updateDraft.handler({ voucherId: "11", description: "x" }, s.ctx)).rejects.toThrow(/enshrined/);
    s = fakeSevdesk({ vouchers: [draft()], positions: [{ ...draftPosition }] });
    await expect(updateDraft.handler({ voucherId: "11" }, s.ctx)).rejects.toThrow(/Nothing to change/);
  });
});

describe("sevdesk_update_draft_voucher: finalize gate, tax rule, gross round trip", () => {
  it("refuses finalize without SEVDESK_ALLOW_BOOKING, dry runs included", async () => {
    const s = fakeSevdesk({ vouchers: [draft()], positions: [{ ...draftPosition }] });
    await expect(updateDraft.handler({ voucherId: "11", finalize: true }, s.ctx)).rejects.toThrow(/SEVDESK_ALLOW_BOOKING/);
    await expect(updateDraft.handler({ voucherId: "11", finalize: true, dryRun: true }, s.ctx)).rejects.toThrow(/SEVDESK_ALLOW_BOOKING/);
    expect(s.sent).toHaveLength(0);
  });

  it("still corrects a draft without the flag", async () => {
    const s = fakeSevdesk({ vouchers: [draft()], positions: [{ ...draftPosition }] });
    const out = (await updateDraft.handler({ voucherId: "11", description: "INV-2" }, s.ctx)) as Row;
    expect(out.changed).toBe(true);
  });

  it("refuses a non-boolean finalize", async () => {
    const s = fakeSevdesk({ vouchers: [draft()], positions: [{ ...draftPosition }] }, { allowBooking: true });
    await expect(updateDraft.handler({ voucherId: "11", finalize: "later" }, s.ctx)).rejects.toThrow(/finalize must be true or false/);
  });

  it("checks a new taxRuleId against the voucher's side", async () => {
    const s = fakeSevdesk({ vouchers: [draft()], positions: [{ ...draftPosition }] });
    // rule 1 is a revenue rule; the voucher is an expense (C)
    await expect(updateDraft.handler({ voucherId: "11", taxRuleId: "1" }, s.ctx)).rejects.toThrow(/revenue rule|cannot be used/);
    expect(s.sent).toHaveLength(0);
  });

  it("checks a new taxRuleId against the kept positions' rates", async () => {
    const s = fakeSevdesk({ vouchers: [draft()], positions: [{ ...draftPosition, taxRate: 19 }] });
    // 12 = reverse charge expense, only 0 % allowed
    await expect(updateDraft.handler({ voucherId: "11", taxRuleId: "12" }, s.ctx)).rejects.toThrow(/allows only 0 %.*position 1 has 19 %/);
    expect(s.sent).toHaveLength(0);
  });

  it("changes the tax rule when the kept positions fit", async () => {
    const s = fakeSevdesk({ vouchers: [draft()], positions: [{ ...draftPosition }] });
    const out = (await updateDraft.handler({ voucherId: "11", taxRuleId: "12" }, s.ctx)) as Row;
    expect(out.changed).toBe(true);
    expect(((s.sent[0]!.body as Row).voucher as Row).taxRule).toEqual({ id: "12", objectName: "TaxRule" });
  });

  it("re-sends a gross-entered position as gross, not net", async () => {
    const gross = { ...draftPosition, net: "0", taxRate: 19, sumNet: 180.0, sumGross: 214.2, sumTax: 34.2 };
    const s = fakeSevdesk({ vouchers: [draft({ sumNet: 180, sumTax: 34.2 })], positions: [gross] });
    await updateDraft.handler({ voucherId: "11", description: "INV-2" }, s.ctx);
    const pos = (s.sent[0]!.body as { voucherPosSave: Row[] }).voucherPosSave[0]!;
    expect(pos).toMatchObject({ net: false, sumGross: 214.2 });
    expect(pos).not.toHaveProperty("sumNet");
  });

  it("re-sends a net-entered position as net", async () => {
    const net = { ...draftPosition, net: "1", taxRate: 0 };
    const s = fakeSevdesk({ vouchers: [draft()], positions: [net] });
    await updateDraft.handler({ voucherId: "11", description: "INV-2" }, s.ctx);
    expect((s.sent[0]!.body as { voucherPosSave: Row[] }).voucherPosSave[0]).toMatchObject({ net: true, sumNet: 214.2 });
  });
});

describe("sevdesk_upload_voucher_file_content: XML e-invoices", () => {
  const xml = (s: string) => Buffer.from(s).toString("base64");

  it("accepts an XRechnung-style XML", async () => {
    const s = fakeSevdesk({});
    const doc = '<?xml version="1.0" encoding="UTF-8"?>\n<ubl:Invoice xmlns:ubl="x"><cbc:ID>1</cbc:ID></ubl:Invoice>\n';
    const out = (await upload.handler({ fileName: "xrechnung.xml", base64Content: xml(doc) }, s.ctx)) as Row;
    expect(out.fileName).toBe("abc123.pdf");
    expect(((s.sent[0]!.form as FormData).get("file") as File).type).toBe("application/xml");
  });

  it("refuses non-XML content under an .xml name, and XML under a .pdf name", async () => {
    const s = fakeSevdesk({});
    await expect(upload.handler({ fileName: "a.xml", base64Content: xml("hello world") }, s.ctx)).rejects.toThrow(/not a PDF, PNG, JPG or XML/);
    await expect(upload.handler({ fileName: "a.xml", base64Content: xml("<a>broken") }, s.ctx)).rejects.toThrow(/not a PDF, PNG, JPG or XML/);
    await expect(upload.handler({ fileName: "a.xml", base64Content: Buffer.from([0x3c, 0x61, 0x00, 0xff, 0x3e]).toString("base64") }, s.ctx)).rejects.toThrow(/not a PDF/);
    await expect(upload.handler({ fileName: "a.pdf", base64Content: xml("<a>x</a>") }, s.ctx)).rejects.toThrow(/application\/xml.*\.pdf/);
    expect(s.sent).toHaveLength(0);
  });
});

describe("sevdesk_update_draft_voucher: strict net flag, rounding, failed checks", () => {
  it.each([[true], ["1"], [1], ["true"]])("reads net=%j as net", async (net) => {
    const s = fakeSevdesk({ vouchers: [draft()], positions: [{ ...draftPosition, net }] });
    await updateDraft.handler({ voucherId: "11", description: "x" }, s.ctx);
    expect((s.sent[0]!.body as { voucherPosSave: Row[] }).voucherPosSave[0]).toMatchObject({ net: true, sumNet: 214.2 });
  });

  it.each([[false], ["0"], [0], ["false"]])("reads net=%j as gross", async (net) => {
    const s = fakeSevdesk({ vouchers: [draft()], positions: [{ ...draftPosition, net, sumGross: 214.2 }] });
    await updateDraft.handler({ voucherId: "11", description: "x" }, s.ctx);
    const pos = (s.sent[0]!.body as { voucherPosSave: Row[] }).voucherPosSave[0]!;
    expect(pos).toMatchObject({ net: false, sumGross: 214.2 });
    expect(pos).not.toHaveProperty("sumNet");
  });

  it.each([[undefined], [null], ["maybe"], [""]])("refuses an unreadable net flag (%j)", async (net) => {
    const s = fakeSevdesk({ vouchers: [draft()], positions: [{ ...draftPosition, net }] });
    await expect(updateDraft.handler({ voucherId: "11", description: "x" }, s.ctx)).rejects.toThrow(/entered as net or gross/);
    expect(s.sent).toHaveLength(0);
  });

  it("rounds per position before summing the expected totals", async () => {
    const s = fakeSevdesk({ vouchers: [draft()], positions: [{ ...draftPosition }] });
    const out = (await updateDraft.handler(
      { voucherId: "11", dryRun: true, positions: Array.from({ length: 10 }, () => ({ sumNet: 0.03, taxRate: 19 })) },
      s.ctx,
    )) as { expected: Row };
    expect(out.expected).toEqual({ net: 0.3, gross: 0.4 });
  });

  it("reports verified: false when the sums come back different", async () => {
    const s = fakeSevdesk({ vouchers: [draft()], positions: [{ ...draftPosition }] });
    const real = s.ctx.client.request.bind(s.ctx.client);
    (s.ctx.client as { request: unknown }).request = async (req: { path: string }) => {
      const out = await real(req as never);
      if (req.path === "/Voucher/Factory/saveVoucher") s.vouchers.get("11")!.sumGross = 999;
      return out;
    };
    const out = (await updateDraft.handler({ voucherId: "11", description: "x" }, s.ctx)) as { verified: boolean; checks: Row };
    expect(out.verified).toBe(false);
    expect(out.checks).toMatchObject({ sums: false, fileKept: true });
  });

  it("reports verified: false when the attached file is lost", async () => {
    const s = fakeSevdesk({ vouchers: [draft()], positions: [{ ...draftPosition }] });
    const real = s.ctx.client.request.bind(s.ctx.client);
    (s.ctx.client as { request: unknown }).request = async (req: { path: string }) => {
      const out = await real(req as never);
      if (req.path === "/Voucher/Factory/saveVoucher") s.vouchers.get("11")!.document = null;
      return out;
    };
    const out = (await updateDraft.handler({ voucherId: "11", description: "x" }, s.ctx)) as { verified: boolean; checks: Row };
    expect(out.verified).toBe(false);
    expect(out.checks).toMatchObject({ fileKept: false, sums: true });
  });
});
