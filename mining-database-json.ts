import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import type { MiningResult } from "./mining-engine";

export interface SessionStats {
  sessionId: number;
  txCount: number;
  totalEthWei: string;
  totalFctWei: string;
  totalEthEth: number;
  totalFctFct: number;
  avgEfficiency: number;
  avgCostPerFct: number;
  startedAt: Date;
  endedAt?: Date;
}

export interface TransactionRecord {
  id: number;
  sessionId: number;
  l1Hash: string;
  facetHash: string;
  ethBurnedWei: string;
  ethBurnedEth: number;
  fctMintedWei: string;
  fctMintedFct: number;
  efficiency: number;
  costPerFct: string;
  gasUsed: string;
  effectiveGasPrice: string;
  baseFeePerGas: string;
  timestamp: number;
}

interface DatabaseData {
  sessions: Array<{
    id: number;
    startedAt: number;
    endedAt?: number;
    totalEthSpentWei: string;
    totalEthSpentEth: number;
    totalFctMinedWei: string;
    totalFctMinedFct: number;
    strategy: string;
    status: string;
  }>;
  transactions: TransactionRecord[];
  runtimeState: Record<string, { value: string; updatedAt: number }>;
  nextSessionId: number;
  nextTransactionId: number;
}

export class MiningDatabase {
  private dbPath: string;
  private data: DatabaseData;

  constructor(dbPath = "./mining-data") {
    // Create directory if it doesn't exist
    if (!existsSync(dbPath)) {
      mkdirSync(dbPath, { recursive: true });
    }
    
    this.dbPath = join(dbPath, "mining.json");
    this.load();
  }

  private load() {
    if (existsSync(this.dbPath)) {
      try {
        const jsonData = readFileSync(this.dbPath, "utf-8");
        this.data = JSON.parse(jsonData);
      } catch (error) {
        console.log("Creating new database...");
        this.initializeEmpty();
      }
    } else {
      this.initializeEmpty();
    }
  }

  private initializeEmpty() {
    this.data = {
      sessions: [],
      transactions: [],
      runtimeState: {},
      nextSessionId: 1,
      nextTransactionId: 1,
    };
    this.save();
  }

  private save() {
    writeFileSync(this.dbPath, JSON.stringify(this.data, null, 2));
  }

  createSession(strategy: string): number {
    const sessionId = this.data.nextSessionId++;
    this.data.sessions.push({
      id: sessionId,
      startedAt: Date.now(),
      totalEthSpentWei: "0",
      totalEthSpentEth: 0,
      totalFctMinedWei: "0",
      totalFctMinedFct: 0,
      strategy,
      status: "active",
    });
    this.save();
    return sessionId;
  }

  endSession(sessionId: number) {
    const session = this.data.sessions.find(s => s.id === sessionId);
    if (session) {
      session.endedAt = Date.now();
      session.status = "completed";
      this.save();
    }
  }

  saveTransaction(tx: MiningResult, sessionId: number) {
    const ethEth = Number(tx.ethBurned) / 1e18;
    const fctFct = Number(tx.fctMinted) / 1e18;
    
    const transaction: TransactionRecord = {
      id: this.data.nextTransactionId++,
      sessionId,
      l1Hash: tx.l1Hash,
      facetHash: tx.facetHash,
      ethBurnedWei: tx.ethBurned.toString(),
      ethBurnedEth: ethEth,
      fctMintedWei: tx.fctMinted.toString(),
      fctMintedFct: fctFct,
      efficiency: tx.efficiency,
      costPerFct: tx.costPerFct.toString(),
      gasUsed: tx.gasUsed.toString(),
      effectiveGasPrice: tx.effectiveGasPrice.toString(),
      baseFeePerGas: tx.baseFeePerGas.toString(),
      timestamp: Date.now(),
    };
    
    this.data.transactions.push(transaction);
    this.updateSessionTotals(sessionId);
    this.save();
  }

  private updateSessionTotals(sessionId: number) {
    const session = this.data.sessions.find(s => s.id === sessionId);
    if (!session) return;
    
    const sessionTxs = this.data.transactions.filter(tx => tx.sessionId === sessionId);
    
    // Calculate totals
    const ethTotal = sessionTxs.reduce((sum, tx) => sum + BigInt(tx.ethBurnedWei), 0n);
    const fctTotal = sessionTxs.reduce((sum, tx) => sum + BigInt(tx.fctMintedWei), 0n);
    const ethTotalEth = sessionTxs.reduce((sum, tx) => sum + tx.ethBurnedEth, 0);
    const fctTotalFct = sessionTxs.reduce((sum, tx) => sum + tx.fctMintedFct, 0);
    
    session.totalEthSpentWei = ethTotal.toString();
    session.totalEthSpentEth = ethTotalEth;
    session.totalFctMinedWei = fctTotal.toString();
    session.totalFctMinedFct = fctTotalFct;
  }

  getSessionStats(sessionId: number): SessionStats | null {
    const session = this.data.sessions.find(s => s.id === sessionId);
    if (!session) return null;
    
    const sessionTxs = this.data.transactions.filter(tx => tx.sessionId === sessionId);
    
    const avgEfficiency = sessionTxs.length > 0
      ? sessionTxs.reduce((sum, tx) => sum + tx.efficiency, 0) / sessionTxs.length
      : 0;
    
    const avgCostPerFct = session.totalFctMinedFct > 0
      ? session.totalEthSpentEth / session.totalFctMinedFct
      : 0;
    
    return {
      sessionId: session.id,
      txCount: sessionTxs.length,
      totalEthWei: session.totalEthSpentWei,
      totalFctWei: session.totalFctMinedWei,
      totalEthEth: session.totalEthSpentEth,
      totalFctFct: session.totalFctMinedFct,
      avgEfficiency,
      avgCostPerFct,
      startedAt: new Date(session.startedAt),
      endedAt: session.endedAt ? new Date(session.endedAt) : undefined,
    };
  }

  getAllTimeStats(): SessionStats {
    const allTxs = this.data.transactions;
    
    if (allTxs.length === 0) {
      return {
        sessionId: 0,
        txCount: 0,
        totalEthWei: "0",
        totalFctWei: "0",
        totalEthEth: 0,
        totalFctFct: 0,
        avgEfficiency: 0,
        avgCostPerFct: 0,
        startedAt: new Date(),
      };
    }
    
    const totalEthEth = allTxs.reduce((sum, tx) => sum + tx.ethBurnedEth, 0);
    const totalFctFct = allTxs.reduce((sum, tx) => sum + tx.fctMintedFct, 0);
    const avgEfficiency = allTxs.reduce((sum, tx) => sum + tx.efficiency, 0) / allTxs.length;
    const avgCostPerFct = totalFctFct > 0 ? totalEthEth / totalFctFct : 0;
    const firstSession = this.data.sessions[0];
    
    return {
      sessionId: 0,
      txCount: allTxs.length,
      totalEthWei: "0", // Not tracking aggregate wei in all-time
      totalFctWei: "0",
      totalEthEth,
      totalFctFct,
      avgEfficiency,
      avgCostPerFct,
      startedAt: firstSession ? new Date(firstSession.startedAt) : new Date(),
    };
  }

  getBestHours(limit = 3): Array<{ hour: number; avgFctPerEth: number; txCount: number }> {
    const hourMap = new Map<number, { totalFct: number; totalEth: number; count: number }>();
    
    for (const tx of this.data.transactions) {
      const hour = new Date(tx.timestamp).getHours();
      const existing = hourMap.get(hour) || { totalFct: 0, totalEth: 0, count: 0 };
      hourMap.set(hour, {
        totalFct: existing.totalFct + tx.fctMintedFct,
        totalEth: existing.totalEth + tx.ethBurnedEth,
        count: existing.count + 1,
      });
    }
    
    const hourStats = Array.from(hourMap.entries())
      .map(([hour, stats]) => ({
        hour,
        avgFctPerEth: stats.totalEth > 0 ? stats.totalFct / stats.totalEth : 0,
        txCount: stats.count,
      }))
      .sort((a, b) => b.avgFctPerEth - a.avgFctPerEth)
      .slice(0, limit);
    
    return hourStats;
  }

  getRecentTransactions(limit = 10): TransactionRecord[] {
    return this.data.transactions
      .slice(-limit)
      .reverse();
  }

  saveRuntimeState(key: string, value: string) {
    this.data.runtimeState[key] = {
      value,
      updatedAt: Date.now(),
    };
    this.save();
  }

  getRuntimeState(key: string): string | null {
    const state = this.data.runtimeState[key];
    return state ? state.value : null;
  }

  getHourlyStats(): Array<{
    hour: number;
    avgFctPerEth: number;
    avgEfficiency: number;
    txCount: number;
    totalFct: number;
    totalEth: number;
  }> {
    const hourMap = new Map<number, {
      totalFct: number;
      totalEth: number;
      totalEfficiency: number;
      count: number;
    }>();
    
    for (const tx of this.data.transactions) {
      const hour = new Date(tx.timestamp).getHours();
      const existing = hourMap.get(hour) || {
        totalFct: 0,
        totalEth: 0,
        totalEfficiency: 0,
        count: 0,
      };
      
      hourMap.set(hour, {
        totalFct: existing.totalFct + tx.fctMintedFct,
        totalEth: existing.totalEth + tx.ethBurnedEth,
        totalEfficiency: existing.totalEfficiency + tx.efficiency,
        count: existing.count + 1,
      });
    }
    
    return Array.from(hourMap.entries()).map(([hour, stats]) => ({
      hour,
      avgFctPerEth: stats.totalEth > 0 ? stats.totalFct / stats.totalEth : 0,
      avgEfficiency: stats.count > 0 ? stats.totalEfficiency / stats.count : 0,
      txCount: stats.count,
      totalFct: stats.totalFct,
      totalEth: stats.totalEth,
    }));
  }

  getTransactionsForAnalysis(opts?: { sessionId?: number; days?: number }): TransactionRecord[] {
    let txs = this.data.transactions;
    
    if (opts?.sessionId) {
      txs = txs.filter(tx => tx.sessionId === opts.sessionId);
    } else if (opts?.days) {
      const cutoff = Date.now() - opts.days * 86400000;
      txs = txs.filter(tx => tx.timestamp > cutoff);
    }
    
    return txs.sort((a, b) => b.timestamp - a.timestamp);
  }

  close() {
    // Save final state
    this.save();
  }
}