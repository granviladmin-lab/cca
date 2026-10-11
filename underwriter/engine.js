/*
 * Resident financial underwriting engine (clean-room).
 *
 * Monte Carlo simulation of a CCRC applicant (single or couple) living through
 * Independent Living -> Assisted Living -> Skilled Nursing, projecting assets,
 * income, fees, long-term care insurance, life insurance, and any fee subsidy the
 * community would have to provide once the resident's money runs out.
 *
 * All actuarial assumptions are illustrative defaults and live in ASSUMPTIONS so a
 * community can replace them with its own experience study.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LEVELS = ['IL', 'AL', 'SN'];

  const ASSUMPTIONS = {
    // Gompertz mortality q(x) = a * exp(b * x), roughly fitted to recent US
    // population tables, then reduced by a CCRC selection factor.
    mortality: { M: { a: 6.0e-5, b: 0.086 }, F: { a: 2.28e-5, b: 0.0936 } },
    selection: 0.85,
    health: { excellent: 0.75, good: 1.0, fair: 1.4, poor: 2.0 },
    levelMortality: { IL: 1.0, AL: 2.0, SN: 3.5 },
    // Annual transition probabilities, p = base * exp(slope * (age - 65)).
    transitions: {
      IL_AL: { base: 0.008, slope: 0.08 },
      IL_SN: { base: 0.004, slope: 0.085 },
      AL_SN: { base: 0.10, slope: 0.03 },
    },
    healthMorbidity: { excellent: 0.8, good: 1.0, fair: 1.3, poor: 1.7 },
    maxAge: 115,
  };

  // Deterministic PRNG (mulberry32) so a run can be reproduced from its seed.
  function rng(seed) {
    let t = seed >>> 0;
    return function () {
      t = (t + 0x6d2b79f5) >>> 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }
  function normal(rand) {
    let u = 0;
    while (u === 0) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  }

  function qx(person, age, level, A) {
    const m = A.mortality[person.sex] || A.mortality.F;
    const q = m.a * Math.exp(m.b * age) * A.selection * (A.health[person.health] || 1) * A.levelMortality[level];
    return Math.min(1, q);
  }

  function transition(person, age, level, rand, A) {
    const k = A.healthMorbidity[person.health] || 1;
    const p = (t) => Math.min(1, t.base * Math.exp(t.slope * (age - 65)) * k);
    const u = rand();
    if (level === 'IL') {
      const pAL = p(A.transitions.IL_AL), pSN = p(A.transitions.IL_SN);
      if (u < pSN) return 'SN';
      if (u < pSN + pAL) return 'AL';
    } else if (level === 'AL' && u < p(A.transitions.AL_SN)) return 'SN';
    return level;
  }

  /*
   * Monthly fee for one resident at a care level under the contract type.
   *  A (life care): stays at the IL rate whatever the care level.
   *  B (modified):  free care days at the IL rate, then a discount off market rate.
   *  C (fee-for-service): full market rate for AL/SN.
   */
  function monthlyFee(app, level, second, careDaysUsed) {
    const f = app.fees;
    const il = second ? f.secondPersonFee : f.monthlyFee;
    if (level === 'IL') return il;
    const market = level === 'AL' ? f.alMonthly : f.snMonthly;
    const c = app.contract;
    if (c.type === 'A') return il;
    if (c.type === 'B') {
      if (careDaysUsed < c.freeCareDays) return il;
      return market * (1 - c.discountPct / 100);
    }
    return market;
  }

  function ltcBenefit(policy, level, state, yearsSinceEntry) {
    if (!policy || !policy.enabled || level === 'IL') return 0;
    if (state.ltcExhausted) return 0;
    const infl = Math.pow(1 + (policy.inflationRider || 0) / 100, yearsSinceEntry);
    const daily = policy.dailyBenefit * infl;
    // The elimination period is served during the first year of care.
    const eligibleDays = state.careDays === 0 ? Math.max(0, 365 - policy.eliminationDays) : 365;
    let pay = daily * eligibleDays;
    const cap = policy.benefitYears * 365 * policy.dailyBenefit;
    pay = Math.min(pay, Math.max(0, cap - state.ltcPaid));
    state.ltcPaid += pay;
    if (state.ltcPaid >= cap) state.ltcExhausted = true;
    return pay;
  }

  /*
   * Life insurance policies. Each policy insures one person (0 or 1).
   *  - cash value: optionally counted as a liquid asset reserve; surrendered when
   *    other assets run out (if allowed) instead of the community subsidising.
   *  - death benefit: if the insured dies while the other spouse survives it
   *    flows into the couple's assets; at the last death it goes to the estate.
   *  - accelerated death benefit (ADB): a share of face paid while insured is in
   *    skilled nursing, reducing the eventual death benefit.
   *  - premiums are an annual expense; unpaid premiums lapse term policies and
   *    are drawn from cash value on permanent ones.
   */
  function initPolicies(app) {
    return (app.lifeInsurance || []).filter((p) => p.enabled !== false).map((p) => ({
      ...p,
      cv: p.type === 'term' ? 0 : p.cashValue || 0,
      face: p.faceAmount || 0,
      inForce: true,
      adbPaid: 0,
    }));
  }

  function simulateOne(app, rand, A, opts) {
    const years = opts.years;
    const people = app.residents.map((r) => ({ ...r, alive: true, level: 'IL', age: r.age, careDays: 0 }));
    const ltcState = people.map(() => ({ ltcPaid: 0, ltcExhausted: false, careDays: 0 }));
    const policies = opts.includeLife ? initPolicies(app) : [];
    const infl = app.economics.feeInflation / 100;
    const cola = app.economics.incomeCola / 100;
    const mu = app.economics.returnMean / 100;
    const sigma = app.economics.returnStdev / 100;

    let assets = app.finances.liquidAssets + (app.finances.otherAssets || 0) - app.fees.entranceFee * (people.length > 1 ? 1 + (app.fees.secondPersonEntrancePct || 0) / 100 : 1);
    let subsidyTotal = 0, subsidyPV = 0, firstSubsidyYear = -1, estate = 0;
    const netWorth = new Float64Array(years).fill(NaN);
    const subsidy = new Float64Array(years);
    const lifeValue = new Float64Array(years);
    const levelCount = { IL: new Float64Array(years), AL: new Float64Array(years), SN: new Float64Array(years) };
    let deathYear = years;

    for (let y = 0; y < years; y++) {
      const alive = people.filter((p) => p.alive);
      if (!alive.length) { deathYear = y; break; }
      const priceIdx = Math.pow(1 + infl, y);

      // Income and expenses for the year.
      const colaIdx = Math.pow(1 + cola, y);
      let income = 0;
      for (const p of alive) income += (p.income || 0) * colaIdx;
      if (people.length > 1 && alive.length === 1) {
        // Survivor keeps the larger of their own income or a share of the couple's.
        const combined = people.reduce((s, p) => s + (p.income || 0), 0) * colaIdx;
        income = Math.max(income, combined * (app.finances.survivorIncomePct || 0) / 100);
      }

      let fees = 0;
      alive.forEach((p, i) => {
        const second = i > 0;
        fees += 12 * monthlyFee(app, p.level, second, p.careDays) * priceIdx;
      });
      const other = (app.finances.otherExpenses || 0) * priceIdx * (alive.length === 1 && people.length > 1 ? 0.6 : 1);

      let ltc = 0;
      people.forEach((p, i) => {
        if (p.alive) ltc += ltcBenefit(app.ltcPolicies && app.ltcPolicies[i], p.level, ltcState[i], y);
      });
      let ltcPremium = 0;
      people.forEach((p, i) => {
        const pol = app.ltcPolicies && app.ltcPolicies[i];
        if (p.alive && pol && pol.enabled && p.level === 'IL') ltcPremium += pol.annualPremium || 0;
      });

      // Life insurance premiums, cash value growth and ADB.
      let lifePremium = 0, adb = 0;
      for (const pol of policies) {
        if (!pol.inForce) continue;
        const insured = people[pol.insured || 0];
        if (!insured.alive) continue;
        if (pol.type === 'term' && insured.age >= (pol.termEndAge || 200)) { pol.inForce = false; continue; }
        if (y < (pol.premiumYears ?? 99)) lifePremium += pol.annualPremium || 0;
        if (pol.type !== 'term') pol.cv *= 1 + (pol.cvGrowth || 0) / 100;
        if (pol.adbPct && insured.level === 'SN' && pol.adbPaid < pol.face * pol.adbPct / 100) {
          const pay = Math.min(pol.face * pol.adbPct / 100 - pol.adbPaid, pol.face * pol.adbPct / 100 / 2);
          pol.adbPaid += pay; adb += pay; pol.face -= pay;
          if (pol.type !== 'term') pol.cv = Math.max(0, pol.cv - pay * (pol.cv / (pol.face + pay)));
        }
      }

      const ret = Math.exp(mu - sigma * sigma / 2 + sigma * normal(rand)) - 1;
      if (assets > 0) assets *= 1 + ret;
      assets += income + ltc + adb - fees - other - ltcPremium - lifePremium;

      // When money runs out: surrender permanent policies first, if allowed.
      if (assets < 0) {
        for (const pol of policies) {
          if (assets >= 0) break;
          if (!pol.inForce || pol.type === 'term' || !pol.surrenderWhenNeeded) continue;
          assets += pol.cv * (1 - (pol.surrenderChargePct || 0) / 100);
          pol.cv = 0; pol.inForce = false; pol.face = 0;
        }
      }
      // Term premiums that can't be paid lapse the policy.
      if (assets < 0) for (const pol of policies) if (pol.type === 'term' && pol.inForce) pol.inForce = false;

      if (assets < 0) {
        const s = -assets;
        subsidy[y] = s;
        subsidyTotal += s;
        subsidyPV += s / Math.pow(1 + app.economics.discountRate / 100, y + 0.5);
        if (firstSubsidyYear < 0) firstSubsidyYear = y;
        assets = 0;
      }

      // Year-end: deaths, then transitions for survivors.
      for (let i = 0; i < people.length; i++) {
        const p = people[i];
        if (!p.alive) continue;
        if (p.level !== 'IL') { p.careDays += 365; ltcState[i].careDays += 365; }
        if (rand() < qx(p, p.age, p.level, A) || p.age >= A.maxAge) {
          p.alive = false;
          const survivors = people.some((o) => o.alive);
          for (const pol of policies) {
            if ((pol.insured || 0) !== i || !pol.inForce) continue;
            if (survivors) assets += pol.face; else estate += pol.face;
            pol.inForce = false;
          }
        } else {
          p.level = transition(p, p.age, p.level, rand, A);
          p.age += 1;
        }
      }

      let li = 0;
      for (const pol of policies) if (pol.inForce) li += opts.lifeValueBasis === 'face' ? pol.face : pol.cv;
      lifeValue[y] = li;
      netWorth[y] = assets + (app.lifeOptions && app.lifeOptions.countInNetWorth ? li : 0);
      for (const p of people) if (p.alive) levelCount[p.level][y] += 1;
    }

    const refund = app.fees.entranceFee * (app.contract.refundPct || 0) / 100;
    estate += Math.max(0, assets) + refund;
    return { subsidyTotal, subsidyPV, firstSubsidyYear, netWorth, subsidy, lifeValue, levelCount, deathYear, estate };
  }

  function percentile(sorted, p) {
    if (!sorted.length) return NaN;
    const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    return sorted[i];
  }

  function run(app, options = {}) {
    const A = deepMerge(ASSUMPTIONS, options.assumptions || {});
    const sims = options.simulations || 2500;
    const startAge = Math.min(...app.residents.map((r) => r.age));
    const years = Math.max(1, A.maxAge - startAge + 1);
    const opts = { years, includeLife: options.includeLife !== false, lifeValueBasis: (app.lifeOptions && app.lifeOptions.valueBasis) || 'cash' };
    const rand = rng(options.seed ?? 12345);

    let anySubsidy = 0, pvSum = 0, totalSum = 0, estateSum = 0;
    const firstYears = [], lifeYears = [], estates = [];
    const nwByYear = Array.from({ length: years }, () => []);
    const subByYear = new Float64Array(years);
    const liByYear = new Float64Array(years);
    const occ = { IL: new Float64Array(years), AL: new Float64Array(years), SN: new Float64Array(years) };
    const pvs = [];

    for (let s = 0; s < sims; s++) {
      const r = simulateOne(app, rand, A, opts);
      if (r.subsidyTotal > 0) { anySubsidy++; firstYears.push(r.firstSubsidyYear); }
      pvSum += r.subsidyPV; totalSum += r.subsidyTotal; estateSum += r.estate;
      pvs.push(r.subsidyPV); estates.push(r.estate); lifeYears.push(r.deathYear);
      for (let y = 0; y < years; y++) {
        if (!Number.isNaN(r.netWorth[y])) nwByYear[y].push(r.netWorth[y]);
        subByYear[y] += r.subsidy[y] / sims;
        liByYear[y] += r.lifeValue[y] / sims;
        for (const l of LEVELS) occ[l][y] += r.levelCount[l][y] / sims;
      }
    }

    const byYear = [];
    for (let y = 0; y < years; y++) {
      const v = nwByYear[y].sort((a, b) => a - b);
      const aliveShare = v.length / sims;
      if (aliveShare < 0.02) break;
      byYear.push({
        year: y, age: startAge + y, aliveShare,
        nwP10: percentile(v, 0.1), nwP50: percentile(v, 0.5), nwP90: percentile(v, 0.9),
        expectedSubsidy: subByYear[y], lifeValue: liByYear[y],
        IL: occ.IL[y], AL: occ.AL[y], SN: occ.SN[y],
      });
    }
    pvs.sort((a, b) => a - b); estates.sort((a, b) => a - b);
    firstYears.sort((a, b) => a - b); lifeYears.sort((a, b) => a - b);

    const probSubsidy = anySubsidy / sims;
    const expectedPV = pvSum / sims;
    const th = app.thresholds || { approveProb: 0.10, declineProb: 0.35 };
    const rating = probSubsidy <= th.approveProb ? 'Approve' : probSubsidy >= th.declineProb ? 'Decline' : 'Review';

    return {
      simulations: sims, probSubsidy, expectedPV, expectedTotal: totalSum / sims,
      pvP95: percentile(pvs, 0.95),
      medianYearsToSubsidy: firstYears.length ? percentile(firstYears, 0.5) : null,
      medianYearsInCommunity: percentile(lifeYears, 0.5),
      expectedEstate: estateSum / sims, estateP50: percentile(estates, 0.5),
      rating, byYear,
    };
  }

  // Runs the applicant with and without life insurance so the report can show
  // how much the policies reduce subsidy risk.
  function analyze(app, options = {}) {
    const withLife = run(app, { ...options, includeLife: true });
    const hasLife = (app.lifeInsurance || []).some((p) => p.enabled !== false);
    const withoutLife = hasLife ? run(app, { ...options, includeLife: false }) : null;
    return { withLife, withoutLife };
  }

  function deepMerge(a, b) {
    if (typeof a !== 'object' || a === null || Array.isArray(a)) return b === undefined ? a : b;
    const out = { ...a };
    for (const k of Object.keys(b || {})) out[k] = deepMerge(a[k], b[k]);
    return out;
  }

  function sampleApplicant() {
    return {
      id: 'sample', name: 'Sample couple',
      residents: [
        { name: 'Resident 1', sex: 'M', age: 78, health: 'good', income: 42000 },
        { name: 'Resident 2', sex: 'F', age: 75, health: 'good', income: 26000 },
      ],
      finances: { liquidAssets: 1050000, otherAssets: 0, otherExpenses: 14000, survivorIncomePct: 70 },
      fees: { entranceFee: 380000, secondPersonEntrancePct: 10, monthlyFee: 4600, secondPersonFee: 1700, alMonthly: 7800, snMonthly: 13500 },
      contract: { type: 'B', freeCareDays: 60, discountPct: 20, refundPct: 50 },
      economics: { returnMean: 5, returnStdev: 9, feeInflation: 4, incomeCola: 2.5, discountRate: 5 },
      ltcPolicies: [
        { enabled: false, dailyBenefit: 200, benefitYears: 3, eliminationDays: 90, inflationRider: 3, annualPremium: 3800 },
        { enabled: true, dailyBenefit: 180, benefitYears: 3, eliminationDays: 90, inflationRider: 3, annualPremium: 3200 },
      ],
      lifeInsurance: [
        { enabled: true, label: 'Whole life', insured: 0, type: 'whole', faceAmount: 250000, cashValue: 110000, cvGrowth: 3.5, annualPremium: 0, premiumYears: 0, surrenderWhenNeeded: true, surrenderChargePct: 0, adbPct: 50 },
        { enabled: true, label: 'Term to 85', insured: 1, type: 'term', faceAmount: 150000, cashValue: 0, annualPremium: 2400, premiumYears: 10, termEndAge: 85, surrenderWhenNeeded: false, adbPct: 0 },
      ],
      lifeOptions: { countInNetWorth: true, valueBasis: 'cash' },
      thresholds: { approveProb: 0.10, declineProb: 0.35 },
    };
  }

  return { ASSUMPTIONS, run, analyze, sampleApplicant, _internal: { qx, monthlyFee, rng } };
});
