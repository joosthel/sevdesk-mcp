/**
 * Persona validation: the three user groups from the profile spec, each
 * walked through their real scenario with the actual config loader,
 * profile resolver and tools — only the HTTP client is stubbed.
 *
 * P1 — Solo-Kleinunternehmerin (§19 UStG freelancer)
 * P2 — Regular-VAT GmbH (19 %, foreign SaaS subscriptions)
 * P3 — Advisor/Steuerberater on a voucher-only account, read-only
 */
import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createProfileResolver } from "../src/lib/profile.js";
import type { ToolContext } from "../src/lib/tool.js";
import { auditTools } from "../src/tools/audit.js";
import { resourceTools } from "../src/tools/resources.js";

const ping = resourceTools.find((t) => t.name === "sevdesk_ping")!;
const createInvoice = resourceTools.find((t) => t.name === "sevdesk_create_invoice")!;
const auditVat = auditTools.find((t) => t.name === "sevdesk_audit_vat")!;

type Row = Record<string, unknown>;

function personaCtx(opts: {
  invoices?: Row[];
  vouchers?: Row[];
  positionsByVoucher?: Record<string, Row[]>;
  env?: Record<string, string>;
}) {
  const sent: Array<{ method: string; path: string; body?: unknown }> = [];
  const client = {
    async getAll(path: string): Promise<Row[]> {
      if (path === "/Invoice") return opts.invoices ?? [];
      if (path === "/Voucher") return opts.vouchers ?? [];
      return [];
    },
    async request(req: { method: string; path: string; body?: unknown; query?: Row }) {
      if (req.method === "POST" && req.path === "/Invoice/Factory/saveInvoice") {
        sent.push(req);
        return {
          status: 201,
          data: { objects: { invoice: { id: "1", invoiceNumber: "RE-1", status: "100" } } },
        };
      }
      if (req.path === "/VoucherPos") {
        const id = String(req.query?.["voucher[id]"] ?? "");
        return { status: 200, data: { objects: opts.positionsByVoucher?.[id] ?? [] } };
      }
      if (req.path.startsWith("/ReceiptGuidance")) return { status: 200, data: { objects: [] } };
      if (req.path === "/Tools/bookkeepingSystemVersion")
        return { status: 200, data: { objects: { version: "2.0" } } };
      return { status: 200, data: {} };
    },
  };
  const config = loadConfig({ SEVDESK_API_TOKEN: "test-token", ...opts.env });
  const ctx = {
    client,
    config,
    getProfile: createProfileResolver(client as never, config),
  } as unknown as ToolContext;
  return { ctx, sent };
}

const kuLedger = [
  { status: "200", invoiceDate: "2026-07-01", taxRule: { id: "11" } },
  { status: "1000", invoiceDate: "2026-06-01", taxRule: { id: "11" } },
  { status: "200", invoiceDate: "2026-05-01", smallSettlement: 1 },
];

const regularLedger = [
  { status: "200", invoiceDate: "2026-07-01", taxRule: { id: "1" } },
  { status: "1000", invoiceDate: "2026-06-01", taxRule: { id: "1" } },
  { status: "200", invoiceDate: "2026-05-01", taxRule: { id: "2" } }, // 0 % export, still regular
];

const foreignZeroRateVoucher = {
  id: "20",
  creditDebit: "C",
  voucherDate: "2026-06-01",
  status: "100",
  sumNet: 100,
  sumTax: 0,
  sumGross: 100,
  taxRule: { id: "9" },
  supplierName: "Northwind Cloud, PBC",
};
const foreignVoucherPositions = { "20": [{ taxRate: 0 }] };

describe("P1 — Solo-Kleinunternehmerin, zero configuration", () => {
  it("detects §19 from the ledger and says why", async () => {
    const { ctx } = personaCtx({ invoices: kuLedger });
    const out = (await ping.handler({}, ctx)) as {
      vatProfile: { regime: string; source: string; evidence: string; warning?: string };
    };
    expect(out.vatProfile.regime).toBe("kleinunternehmer");
    expect(out.vatProfile.source).toBe("ledger");
    expect(out.vatProfile.evidence).toContain("§19 signal");
    expect(out.vatProfile.warning).toBeUndefined();
  });

  it("drafts correct §19 invoices without being told", async () => {
    const { ctx, sent } = personaCtx({ invoices: kuLedger });
    await createInvoice.handler(
      { contactId: "7", positions: [{ name: "Logo-Design", price: 500 }] },
      ctx,
    );
    const body = sent[0]!.body as {
      invoice: { taxRule: { id: string }; taxRate: number; taxText: string };
      invoicePosSave: Array<{ taxRate: number }>;
    };
    expect(body.invoice.taxRule.id).toBe("11");
    expect(body.invoicePosSave[0]!.taxRate).toBe(0);
    expect(body.invoice.taxText).toContain("§ 19 UStG");
  });

  it("warns that §13b VAT is genuinely payable for her", async () => {
    const { ctx } = personaCtx({
      invoices: kuLedger,
      vouchers: [foreignZeroRateVoucher],
      positionsByVoucher: foreignVoucherPositions,
    });
    const result = (await auditVat.handler({}, ctx)) as {
      findings: Array<{ code: string; suggestion: string }>;
    };
    const f = result.findings.find((x) => x.code === "zero_rate_booked_as_domestic")!;
    expect(f.suggestion).toContain("taxRule 13");
    expect(f.suggestion).toContain("cannot deduct");
    expect(f.suggestion).not.toContain("taxRule 12");
  });
});

describe("P2 — Regular-VAT GmbH", () => {
  it("gets 19 %/rule-1 defaults from the ledger alone", async () => {
    const { ctx, sent } = personaCtx({ invoices: regularLedger });
    await createInvoice.handler(
      { contactId: "9", positions: [{ name: "Retainer", price: 4000 }] },
      ctx,
    );
    const body = sent[0]!.body as {
      invoice: { taxRule: { id: string }; taxRate: number };
      invoicePosSave: Array<{ taxRate: number }>;
    };
    expect(body.invoice.taxRule.id).toBe("1");
    expect(body.invoicePosSave[0]!.taxRate).toBe(19);
  });

  it("flags a stale Kleinunternehmer flag against a regular ledger", async () => {
    const { ctx } = personaCtx({
      invoices: regularLedger,
      vouchers: [foreignZeroRateVoucher],
      positionsByVoucher: foreignVoucherPositions,
      env: { SEVDESK_KLEINUNTERNEHMER: "true" }, // pasted from someone else's config
    });
    const result = (await auditVat.handler({}, ctx)) as {
      findings: Array<{ code: string; severity: string; detail: string }>;
    };
    const mismatch = result.findings.find((x) => x.code === "vat_regime_mismatch")!;
    expect(mismatch.severity).toBe("high");
    expect(mismatch.detail).toContain("ledger looks 'regular'");
  });

  it("prefers the new env var over the legacy boolean, and rejects typos at startup", () => {
    const config = loadConfig({
      SEVDESK_API_TOKEN: "t",
      SEVDESK_VAT_REGIME: "regular",
      SEVDESK_KLEINUNTERNEHMER: "true",
    });
    expect(config.vatRegime).toBe("regular");
    expect(config.vatRegimeSource).toBe("env");

    expect(() =>
      loadConfig({ SEVDESK_API_TOKEN: "t", SEVDESK_VAT_REGIME: "kleinunterhemer" }),
    ).toThrow(/not valid/);
  });
});

describe("P3 — Advisor on a voucher-only account, read-only", () => {
  const env = { SEVDESK_READ_ONLY: "true" };

  it("reports the regime as unknown and says how to set it", async () => {
    const { ctx } = personaCtx({ env });
    const out = (await ping.handler({}, ctx)) as {
      mode: string;
      vatProfile: { regime: string; evidence: string };
    };
    expect(out.mode).toBe("READ-ONLY");
    expect(out.vatProfile.regime).toBe("unknown");
    expect(out.vatProfile.evidence).toContain("SEVDESK_VAT_REGIME");
  });

  it("gives §13b advice for both regimes, labeled, instead of guessing", async () => {
    const { ctx } = personaCtx({
      env,
      vouchers: [foreignZeroRateVoucher],
      positionsByVoucher: foreignVoucherPositions,
    });
    const result = (await auditVat.handler({}, ctx)) as {
      findings: Array<{ code: string; suggestion: string }>;
    };
    const f = result.findings.find((x) => x.code === "zero_rate_booked_as_domestic")!;
    expect(f.suggestion).toContain("taxRule 12");
    expect(f.suggestion).toContain("Kleinunternehmer");
    expect(result.findings.some((x) => x.code === "vat_regime_mismatch")).toBe(false);
  });

  it("refuses to draft an invoice rather than guess the regime", async () => {
    const { ctx } = personaCtx({});
    await expect(
      createInvoice.handler({ contactId: "1", positions: [{ name: "X", price: 1 }] }, ctx),
    ).rejects.toThrow(/VAT regime is unknown/);
  });
});
