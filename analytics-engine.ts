import { MiningDatabase, type SessionStats, type TransactionRecord } from "./mining-database-json";
import { formatEther } from "viem";
import { getSwapQuote } from "./facet-swapper";
import { parseEther } from "viem";
import { isMainnet } from "./config";

export interface MiningReport {
  // Overview
  totalFctMined: number;
  totalEthSpent: number;
  avgCostPerFct: number;
  txCount: number;
  
  // Performance
  avgEfficiency: number;
  bestTransaction: TransactionSummary | null;
  worstTransaction: TransactionSummary | null;
  bestHour: number | null;
  worstHour: number | null;
  
  // Profitability
  currentMarketPrice: number | null;
  unrealizedPnL: number | null;
  roi: number | null;
  breakEvenPrice: number;
  
  // Recommendations
  optimalStrategy: string;
  suggestedSchedule: number[];
  improvements: string[];
  
  // Time analysis
  periodStart: Date;
  periodEnd: Date;
  activeDays: number;
}

export interface TransactionSummary {
  hash: string;
  fct: number;
  eth: number;
  costPerFct: number;
  efficiency: number;
  timestamp: Date;
}

export interface HourlyStats {
  hour: number;
  avgFctPerEth: number;
  avgEfficiency: number;
  txCount: number;
  totalFct: number;
  totalEth: number;
}

export class AnalyticsEngine {
  constructor(private db: MiningDatabase) {}

  /**
   * Generate comprehensive mining report
   */
  async generateReport(sessionId?: number, days?: number): Promise<MiningReport> {
    // Get base statistics
    const stats = sessionId 
      ? this.db.getSessionStats(sessionId)
      : this.db.getAllTimeStats();
    
    if (!stats || stats.txCount === 0) {
      return this.emptyReport();
    }

    // Get all transactions for detailed analysis
    const transactions = this.getTransactionsForAnalysis(sessionId, days);
    
    // Get current market price
    const marketPrice = await this.getCurrentMarketPrice();
    
    // Calculate profitability metrics
    const profitability = this.calculateProfitability(stats, marketPrice);
    
    // Find best and worst transactions
    const { best, worst } = this.findBestWorstTransactions(transactions);
    
    // Analyze hourly patterns
    const hourlyAnalysis = this.analyzeHourlyPatterns(transactions);
    
    // Generate recommendations
    const recommendations = this.generateRecommendations(stats, hourlyAnalysis, marketPrice);
    
    // Calculate time range
    const timeRange = this.calculateTimeRange(transactions);
    
    return {
      // Overview
      totalFctMined: stats.totalFctFct,
      totalEthSpent: stats.totalEthEth,
      avgCostPerFct: stats.avgCostPerFct,
      txCount: stats.txCount,
      
      // Performance
      avgEfficiency: stats.avgEfficiency,
      bestTransaction: best,
      worstTransaction: worst,
      bestHour: hourlyAnalysis.bestHour,
      worstHour: hourlyAnalysis.worstHour,
      
      // Profitability
      currentMarketPrice: marketPrice,
      unrealizedPnL: profitability.unrealizedPnL,
      roi: profitability.roi,
      breakEvenPrice: profitability.breakEvenPrice,
      
      // Recommendations
      optimalStrategy: recommendations.strategy,
      suggestedSchedule: recommendations.schedule,
      improvements: recommendations.improvements,
      
      // Time analysis
      periodStart: timeRange.start,
      periodEnd: timeRange.end,
      activeDays: timeRange.activeDays,
    };
  }

  /**
   * Get hourly statistics for pattern analysis
   */
  getHourlyStats(): HourlyStats[] {
    const stmt = this.db["db"].prepare(`
      SELECT 
        CAST(strftime('%H', timestamp/1000, 'unixepoch') AS INTEGER) as hour,
        AVG(fct_minted_fct / NULLIF(eth_burned_eth, 0)) as avgFctPerEth,
        AVG(efficiency) as avgEfficiency,
        COUNT(*) as txCount,
        SUM(fct_minted_fct) as totalFct,
        SUM(eth_burned_eth) as totalEth
      FROM transactions
      GROUP BY hour
      ORDER BY hour
    `);
    
    return stmt.all() as HourlyStats[];
  }

  /**
   * Calculate ROI and break-even analysis
   */
  calculateROI(totalEthSpent: number, totalFctMined: number, currentFctPrice: number): {
    currentValue: number;
    totalCost: number;
    profit: number;
    roi: number;
    breakEvenPrice: number;
  } {
    const ethPrice = 3500; // TODO: Get dynamic ETH price
    const totalCost = totalEthSpent * ethPrice;
    const currentValue = totalFctMined * currentFctPrice;
    const profit = currentValue - totalCost;
    const roi = totalCost > 0 ? (profit / totalCost) * 100 : 0;
    const breakEvenPrice = totalFctMined > 0 ? totalCost / totalFctMined : 0;
    
    return {
      currentValue,
      totalCost,
      profit,
      roi,
      breakEvenPrice,
    };
  }

  /**
   * Find optimal mining windows based on historical data
   */
  findOptimalWindows(limit = 5): Array<{ hour: number; score: number; reason: string }> {
    const hourlyStats = this.getHourlyStats();
    
    // Score each hour based on multiple factors
    const scoredHours = hourlyStats.map(h => {
      // Higher FCT/ETH ratio is better
      const efficiencyScore = h.avgFctPerEth * 100;
      
      // More transactions indicate reliable window
      const reliabilityScore = Math.min(h.txCount * 10, 100);
      
      // Prefer high mining efficiency
      const miningEffScore = h.avgEfficiency;
      
      const totalScore = (efficiencyScore * 0.5) + (reliabilityScore * 0.3) + (miningEffScore * 0.2);
      
      return {
        hour: h.hour,
        score: totalScore,
        reason: this.explainWindow(h),
      };
    });
    
    // Sort by score and return top windows
    return scoredHours
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  private explainWindow(stats: HourlyStats): string {
    const reasons = [];
    
    if (stats.avgFctPerEth > 1000) {
      reasons.push("High FCT yield");
    }
    if (stats.avgEfficiency > 98) {
      reasons.push("Excellent efficiency");
    }
    if (stats.txCount > 10) {
      reasons.push("Proven reliable");
    }
    
    return reasons.join(", ") || "Good mining window";
  }

  private async getCurrentMarketPrice(): Promise<number | null> {
    if (!isMainnet()) return null;
    
    try {
      const quote = await getSwapQuote(parseEther("1"));
      if (!quote) return null;
      
      const priceInEth = Number(formatEther(quote.spotPrice));
      const ethPrice = 3500; // TODO: Get dynamic price
      return priceInEth * ethPrice;
    } catch {
      return null;
    }
  }

  private calculateProfitability(stats: SessionStats, marketPrice: number | null) {
    const ethPrice = 3500;
    const totalCostUsd = stats.totalEthEth * ethPrice;
    
    if (!marketPrice || stats.totalFctFct === 0) {
      return {
        unrealizedPnL: null,
        roi: null,
        breakEvenPrice: totalCostUsd / Math.max(stats.totalFctFct, 1),
      };
    }
    
    const currentValueUsd = stats.totalFctFct * marketPrice;
    const unrealizedPnL = currentValueUsd - totalCostUsd;
    const roi = totalCostUsd > 0 ? (unrealizedPnL / totalCostUsd) * 100 : 0;
    
    return {
      unrealizedPnL,
      roi,
      breakEvenPrice: totalCostUsd / stats.totalFctFct,
    };
  }

  private findBestWorstTransactions(transactions: TransactionRecord[]): {
    best: TransactionSummary | null;
    worst: TransactionSummary | null;
  } {
    if (transactions.length === 0) {
      return { best: null, worst: null };
    }
    
    // Sort by cost per FCT
    const sorted = [...transactions].sort((a, b) => {
      const costA = a.ethBurnedEth / Math.max(a.fctMintedFct, 0.0001);
      const costB = b.ethBurnedEth / Math.max(b.fctMintedFct, 0.0001);
      return costA - costB;
    });
    
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];
    
    return {
      best: this.toTransactionSummary(best),
      worst: this.toTransactionSummary(worst),
    };
  }

  private toTransactionSummary(tx: TransactionRecord): TransactionSummary {
    return {
      hash: tx.l1Hash,
      fct: tx.fctMintedFct,
      eth: tx.ethBurnedEth,
      costPerFct: tx.ethBurnedEth / Math.max(tx.fctMintedFct, 0.0001),
      efficiency: tx.efficiency,
      timestamp: new Date(tx.timestamp),
    };
  }

  private analyzeHourlyPatterns(transactions: TransactionRecord[]) {
    const hourlyMap = new Map<number, { totalFct: number; totalEth: number; count: number }>();
    
    // Aggregate by hour
    for (const tx of transactions) {
      const hour = new Date(tx.timestamp).getHours();
      const existing = hourlyMap.get(hour) || { totalFct: 0, totalEth: 0, count: 0 };
      
      hourlyMap.set(hour, {
        totalFct: existing.totalFct + tx.fctMintedFct,
        totalEth: existing.totalEth + tx.ethBurnedEth,
        count: existing.count + 1,
      });
    }
    
    // Find best and worst hours (lower ratio = better, higher ratio = worse)
    let bestHour: number | null = null;
    let worstHour: number | null = null;
    let bestRatio = Infinity;
    let worstRatio = 0;
    
    for (const [hour, data] of hourlyMap.entries()) {
      const ratio = data.totalEth / Math.max(data.totalFct, 0.0001);
      
      if (ratio < bestRatio) {
        bestHour = hour;
        bestRatio = ratio;
      }
      
      if (ratio > worstRatio) {
        worstHour = hour;
        worstRatio = ratio;
      }
    }
    
    return { bestHour, worstHour };
  }

  private generateRecommendations(
    stats: SessionStats,
    hourlyAnalysis: { bestHour: number | null; worstHour: number | null },
    marketPrice: number | null
  ) {
    const improvements: string[] = [];
    let strategy = "balanced";
    const schedule: number[] = [];
    
    // Efficiency recommendations
    if (stats.avgEfficiency < 95) {
      improvements.push("Increase data size to improve mining efficiency");
      strategy = "aggressive";
    } else if (stats.avgEfficiency > 99) {
      improvements.push("Mining efficiency is excellent");
    }
    
    // Cost recommendations
    if (stats.avgCostPerFct > 0.0005) {
      improvements.push("Consider mining only during low gas periods");
      strategy = "economical";
    }
    
    // Schedule recommendations
    if (hourlyAnalysis.bestHour !== null) {
      const bestHours = [
        hourlyAnalysis.bestHour,
        (hourlyAnalysis.bestHour + 1) % 24,
        (hourlyAnalysis.bestHour - 1 + 24) % 24,
      ];
      schedule.push(...bestHours);
      improvements.push(`Focus mining around hour ${hourlyAnalysis.bestHour}:00`);
    }
    
    // Market recommendations
    if (marketPrice && stats.avgCostPerFct < marketPrice * 0.8) {
      improvements.push("Mining is profitable vs DEX - consider arbitrage strategy");
      strategy = "arbitrage";
    }
    
    return {
      strategy,
      schedule: [...new Set(schedule)].sort((a, b) => a - b),
      improvements: improvements.length > 0 ? improvements : ["Mining performance is optimal"],
    };
  }

  private getTransactionsForAnalysis(sessionId?: number, days?: number): TransactionRecord[] {
    let query = "SELECT * FROM transactions";
    const params: any[] = [];
    
    if (sessionId) {
      query += " WHERE session_id = ?";
      params.push(sessionId);
    } else if (days) {
      const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
      query += " WHERE timestamp > ?";
      params.push(cutoff);
    }
    
    query += " ORDER BY timestamp DESC";
    
    const stmt = this.db["db"].prepare(query);
    return stmt.all(...params) as TransactionRecord[];
  }

  private calculateTimeRange(transactions: TransactionRecord[]) {
    if (transactions.length === 0) {
      return {
        start: new Date(),
        end: new Date(),
        activeDays: 0,
      };
    }
    
    const timestamps = transactions.map(tx => tx.timestamp);
    const start = new Date(Math.min(...timestamps));
    const end = new Date(Math.max(...timestamps));
    
    // Calculate active days
    const daySet = new Set<string>();
    for (const ts of timestamps) {
      const date = new Date(ts);
      const dayKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      daySet.add(dayKey);
    }
    
    return {
      start,
      end,
      activeDays: daySet.size,
    };
  }

  private emptyReport(): MiningReport {
    return {
      totalFctMined: 0,
      totalEthSpent: 0,
      avgCostPerFct: 0,
      txCount: 0,
      avgEfficiency: 0,
      bestTransaction: null,
      worstTransaction: null,
      bestHour: null,
      worstHour: null,
      currentMarketPrice: null,
      unrealizedPnL: null,
      roi: null,
      breakEvenPrice: 0,
      optimalStrategy: "economical",
      suggestedSchedule: [],
      improvements: ["No mining data available"],
      periodStart: new Date(),
      periodEnd: new Date(),
      activeDays: 0,
    };
  }
}