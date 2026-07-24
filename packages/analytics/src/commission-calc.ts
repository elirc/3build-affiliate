import type { CommissionStructure } from '@affiliate/shared';

/**
 * Pure commission calculator. Given an order value and a commission
 * structure, return the commission amount in dollars.
 *
 * `priorAffiliateSalesCount` is required for tiered commissions — it's the
 * count of approved conversions this affiliate already has on this campaign
 * BEFORE the current one.
 */
export function calculateCommission(
  structure: CommissionStructure,
  orderValue: number,
  priorAffiliateSalesCount = 0
): number {
  switch (structure.type) {
    case 'flat_per_sale':
      return round2(structure.flatAmount);

    case 'percentage': {
      let amount = (orderValue * structure.percentage) / 100;
      if (structure.minCommission !== undefined) {
        amount = Math.max(amount, structure.minCommission);
      }
      if (structure.maxCommission !== undefined) {
        amount = Math.min(amount, structure.maxCommission);
      }
      return round2(amount);
    }

    case 'tiered_percentage': {
      const tiers = [...structure.tiers].sort(
        (a, b) => a.minSales - b.minSales
      );
      let chosen = tiers[0]!;
      for (const tier of tiers) {
        if (priorAffiliateSalesCount >= tier.minSales) chosen = tier;
      }
      return round2((orderValue * chosen.percentage) / 100);
    }

    case 'recurring':
      return round2((orderValue * structure.percentage) / 100);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
