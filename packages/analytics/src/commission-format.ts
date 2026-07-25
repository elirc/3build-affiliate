import type { CommissionStructure } from '@affiliate/shared';

/**
 * A one-line, human-readable summary of a commission structure.
 *
 * Lives here rather than in a component because three surfaces need it -- the
 * brand's campaign detail page, the affiliate's eligible-campaigns picker, and
 * the public programme cards -- and three copies of a formatting rule become
 * three slightly different answers to "what does this campaign pay?".
 */
export function formatCommission(structure: CommissionStructure): string {
  switch (structure.type) {
    case 'flat_per_sale':
      return `${formatMoney(structure.flatAmount)} per sale`;

    case 'percentage': {
      const bounds: string[] = [];
      if (structure.minCommission !== undefined) {
        bounds.push(`min ${formatMoney(structure.minCommission)}`);
      }
      if (structure.maxCommission !== undefined) {
        bounds.push(`max ${formatMoney(structure.maxCommission)}`);
      }
      const suffix = bounds.length > 0 ? ` (${bounds.join(', ')})` : '';
      return `${formatPercent(structure.percentage)} of sale${suffix}`;
    }

    case 'tiered_percentage': {
      const percentages = structure.tiers.map((t) => t.percentage);
      const low = Math.min(...percentages);
      const high = Math.max(...percentages);
      // A "range" where both ends are equal reads as broken, so collapse it.
      return low === high
        ? `${formatPercent(low)} of sale (tiered)`
        : `${formatPercent(low)}–${formatPercent(high)} of sale (tiered)`;
    }

    case 'recurring':
      return `${formatPercent(structure.percentage)} of sale, recurring for ${
        structure.recurringMonths
      } month${structure.recurringMonths === 1 ? '' : 's'}`;
  }
}

/** Trims a trailing ".0" so 20 reads as "20%" rather than "20.0%". */
function formatPercent(value: number): string {
  return `${Number(value.toFixed(2))}%`;
}

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}
