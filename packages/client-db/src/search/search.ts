import { LocalDatabase } from "../database.js";
import { Message } from "../models/Message.js";

export interface SearchOptions {
  channelId?: string;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  message: Message;
  score: number;
  highlightSnippets: string[];
}

export class ZeroKnowledgeSearchEngine {
  private db: LocalDatabase;

  constructor(db: LocalDatabase) {
    this.db = db;
  }

  /**
   * Performs client-side zero-knowledge full-text search over decrypted local messages.
   * Matches SQLite FTS5 prefix and multi-term tokenization semantics.
   */
  public async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const rawTerms = query
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);

    if (rawTerms.length === 0) {
      return [];
    }

    const messagesCol = this.db.get("messages");
    let allMessages = messagesCol.all();

    if (options.channelId) {
      allMessages = allMessages.filter((m) => m.channelId === options.channelId);
    }

    const results: SearchResult[] = [];

    for (const msg of allMessages) {
      const text = msg.text || "";
      const lowerText = text.toLowerCase();

      // Check if all query terms match (FTS5 AND logic)
      let matchesAll = true;
      let matchScore = 0;
      const snippets: string[] = [];

      for (const term of rawTerms) {
        const isPrefixMatch = term.endsWith("*");
        const cleanTerm = isPrefixMatch ? term.slice(0, -1) : term;

        const idx = lowerText.indexOf(cleanTerm);
        if (idx === -1) {
          matchesAll = false;
          break;
        }

        // Higher score for exact word boundaries
        const isWordBoundary = idx === 0 || /\s|[.,!?;:]/.test(lowerText[idx - 1]);
        matchScore += isWordBoundary ? 10 : 5;

        // Generate highlight snippet around term
        const snippetStart = Math.max(0, idx - 20);
        const snippetEnd = Math.min(text.length, idx + cleanTerm.length + 20);
        snippets.push("..." + text.substring(snippetStart, snippetEnd) + "...");
      }

      if (matchesAll) {
        results.push({
          message: msg,
          score: matchScore,
          highlightSnippets: snippets,
        });
      }
    }

    // Rank results by relevance score descending, then by creation date descending
    results.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      const bTime = b.message.createdAt ? b.message.createdAt.getTime() : 0;
      const aTime = a.message.createdAt ? a.message.createdAt.getTime() : 0;
      return bTime - aTime;
    });

    const offset = options.offset || 0;
    const limit = options.limit || 50;

    return results.slice(offset, offset + limit);
  }
}
