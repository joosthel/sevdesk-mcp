import { describe, expect, it } from "vitest";

import {
  createProfileResolver,
  inferFromInvoices,
  regimeMismatch,
  type VatProfile,
} from "../src/lib/profile.js";

type Row = Record<string, unknown>;

/** A sent (non-draft) invoice row. */
function invoice(overrides: Row): Row {
  return { status: "200", invoiceDate: "2026-06-01", ...overrides };
}

const kuInvoice = (over: Row = {}) => invoice({ taxRule: { id: "11" }, ...over });
const regularInvoice = (over: Row = {}) => invoice({ taxRule: { id: "1" }, ...over });

describe("inferFromInvoices", () => {
  it("detects a pure Kleinunternehmer ledger", () => {
    const v = inferFromInvoices([kuInvoice(), kuInvoice(), kuInvoice()]);
    expect(v.regime).toBe("kleinunternehmer");
    expect(v.kuSignals).toBe(3);
    expect(v.mixed).toBe(false);
  });

  it("detects a regular ledger, counting 0% export/EU rules as regular", () => {
    const v = inferFromInvoices([
      regularInvoice(),
      invoice({ taxRule: { id: "2" } }), // Ausfuhr, 0 %
      invoice({ taxRule: { id: "3" } }), // innergem. Lieferung
    ]);
    expect(v.regime).toBe("regular");
    expect(v.regularSignals).toBe(3);
    expect(v.kuSignals).toBe(0);
  });

  it("reads §19 signals from the legacy generation (smallSettlement / taxText)", () => {
    const v = inferFromInvoices([
      invoice({ smallSettlement: 1 }),
      invoice({ taxText: "Gemäß § 19 UStG wird keine Umsatzsteuer berechnet." }),
    ]);
    expect(v.regime).toBe("kleinunternehmer");
    expect(v.kuSignals).toBe(2);
  });

  it("flags mixed ledgers (regime switch in progress) but keeps the majority", () => {
    const v = inferFromInvoices([
      regularInvoice({ invoiceDate: "2026-07-01" }),
      regularInvoice({ invoiceDate: "2026-06-01" }),
      kuInvoice({ invoiceDate: "2026-01-01" }),
    ]);
    expect(v.regime).toBe("regular");
    expect(v.mixed).toBe(true);
  });

  it("returns unknown for empty or signal-free ledgers", () => {
    expect(inferFromInvoices([]).regime).toBe("unknown");
    // rule 22 is neutral: both regimes book nicht-steuerbare Einnahmen
    expect(inferFromInvoices([invoice({ taxRule: { id: "22" } })]).regime).toBe("unknown");
    expect(inferFromInvoices([null, 42, "junk"]).regime).toBe("unknown");
  });

  it("prefers sent invoices over drafts and says so when only drafts exist", () => {
    const withSent = inferFromInvoices([
      kuInvoice({ status: "100" }),
      regularInvoice({ status: "200" }),
    ]);
    expect(withSent.regime).toBe("regular");
    expect(withSent.draftsOnly).toBe(false);

    const draftsOnly = inferFromInvoices([kuInvoice({ status: "100" })]);
    expect(draftsOnly.regime).toBe("kleinunternehmer");
    expect(draftsOnly.draftsOnly).toBe(true);
  });

  it("judges only the newest invoices, so old history cannot outvote the present", () => {
    const oldKu = Array.from({ length: 30 }, (_, i) =>
      kuInvoice({ invoiceDate: `2024-01-${String((i % 28) + 1).padStart(2, "0")}` }),
    );
    const newRegular = Array.from({ length: 25 }, (_, i) =>
      regularInvoice({ invoiceDate: `2026-07-${String((i % 28) + 1).padStart(2, "0")}` }),
    );
    const v = inferFromInvoices([...oldKu, ...newRegular]);
    expect(v.regime).toBe("regular");
  });
});

function clientWith(rows: Row[] | (() => Row[])): { getAll: () => Promise<Row[]> } {
  return {
    async getAll() {
      return typeof rows === "function" ? rows() : rows;
    },
  };
}

describe("createProfileResolver", () => {
  it("explicit env beats a contradicting ledger, and the contradiction is reported", async () => {
    const resolve = createProfileResolver(clientWith([regularInvoice()]), {
      vatRegime: "kleinunternehmer",
      vatRegimeSource: "env",
    });
    const p = await resolve();
    expect(p.regime).toBe("kleinunternehmer");
    expect(p.source).toBe("env");
    expect(regimeMismatch(p)).toMatch(/ledger looks 'regular'/);
  });

  it("marks the deprecated boolean as legacy-env", async () => {
    const resolve = createProfileResolver(clientWith([]), {
      vatRegime: "kleinunternehmer",
      vatRegimeSource: "legacy-env",
    });
    const p = await resolve();
    expect(p.source).toBe("legacy-env");
    expect(p.evidence).toContain("SEVDESK_KLEINUNTERNEHMER");
    expect(regimeMismatch(p)).toBeNull(); // empty ledger cannot contradict
  });

  it("auto mode infers from the ledger", async () => {
    const resolve = createProfileResolver(clientWith([kuInvoice(), kuInvoice()]), {
      vatRegime: "auto",
      vatRegimeSource: "default",
    });
    const p = await resolve();
    expect(p.regime).toBe("kleinunternehmer");
    expect(p.source).toBe("ledger");
    expect(regimeMismatch(p)).toBeNull(); // nothing configured, nothing to contradict
  });

  it("never throws: a failing lookup yields unknown and retries next call", async () => {
    let calls = 0;
    const flaky = {
      async getAll(): Promise<Row[]> {
        calls++;
        if (calls === 1) throw new Error("api down");
        return [regularInvoice()];
      },
    };
    const resolve = createProfileResolver(flaky, {
      vatRegime: "auto",
      vatRegimeSource: "default",
    });
    const first = await resolve();
    expect(first.regime).toBe("unknown");
    expect(first.source).toBe("unresolved");
    expect(first.evidence).toContain("api down");

    const second = await resolve();
    expect(second.regime).toBe("regular"); // retried, not stuck on the failure
  });

  it("caches the verdict: racing calls share one lookup, later calls refetch nothing", async () => {
    let calls = 0;
    const counting = {
      async getAll(): Promise<Row[]> {
        calls++;
        return [kuInvoice()];
      },
    };
    const resolve = createProfileResolver(counting, {
      vatRegime: "auto",
      vatRegimeSource: "default",
    });
    const [a, b] = await Promise.all([resolve(), resolve()]);
    await resolve();
    expect(calls).toBe(1);
    expect(a.regime).toBe("kleinunternehmer");
    expect(b.regime).toBe("kleinunternehmer");
  });
});

describe("regimeMismatch", () => {
  it("stays silent for ledger-sourced and unresolved profiles", () => {
    const ledgerSourced: VatProfile = {
      regime: "regular",
      source: "ledger",
      evidence: "",
      ledger: { regime: "regular", kuSignals: 0, regularSignals: 3, mixed: false, draftsOnly: false },
    };
    expect(regimeMismatch(ledgerSourced)).toBeNull();
  });
});
