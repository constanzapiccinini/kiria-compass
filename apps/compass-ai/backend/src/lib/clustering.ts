/**
 * Greedy cosine-threshold clustering over question embeddings — §5.
 *
 * Pure functions, no network, no database. That is deliberate: §8 asks whether
 * clustering is deterministic for a fixed input, and the only way to answer that
 * honestly is to be able to run it twice in a test without an API key. It also lets
 * the cost claim in §5 — "a few thousand vectors in JS is fine — **measure** before
 * assuming otherwise" — actually be measured rather than repeated.
 *
 * ---------------------------------------------------------------------------
 * Why a dot product is the cosine
 *
 * `createEmbeddings` normalises every vector to unit length before it is stored
 * (`openai.ts`), so `a · b` **is** cos(a, b) with no division. This module asserts
 * that rather than trusting it: a vector that is not unit-length would silently make
 * every similarity too small, clusters too fine, and the whole screen quietly wrong.
 *
 * ---------------------------------------------------------------------------
 * What "deterministic" means here, exactly
 *
 * §8: "Clustering is deterministic for a fixed input and `prompt_version` — or, if it
 * is not, say so and pin what varies."
 *
 * It is deterministic **for a fixed set of questions**: items are sorted by id before
 * assignment, so the greedy walk visits them in the same order every run and produces
 * byte-identical clusters. Two runs over the same month give the same answer.
 *
 * It is **not** stable under insertion, and no greedy scheme is: adding one question
 * can pull a centroid across the threshold and merge two clusters that were separate
 * last night. So month-over-month comparisons are only sound between runs over the
 * same window, which is why a theme row carries `period_start`/`period_end` and
 * `prompt_version` — comparing two periods means comparing two labelled snapshots, not
 * assuming cluster identity persisted.
 *
 * That is the honest limitation, stated where someone would otherwise assume
 * otherwise.
 */

/**
 * Cosine similarity above which a question joins an existing cluster.
 *
 * **Measured, and provisional.** The first value written here was 0.62, an intuition
 * carried over from full-size embeddings. The clustering test refused it immediately —
 * three well-separated synthetic centres came back as twenty-four clusters — and the
 * production data explains why. Every pairwise cosine between the seven real questions
 * asked so far:
 *
 * ```
 * 0.429  "what can you tell me about its strategic priorities" ~ "Who are the key stakeholders"
 * 0.287  "cuantos candidatos hay"                              ~ "cuales son los colores del branding"
 * 0.261  "tell me about its family tree"                       ~ "…its strategic priorities"
 * 0.218  "quien es ryan isacsson"                              ~ "cuales son los colores del branding"
 * …
 * 0.150  "Who are the key stakeholders"                        ~ "quien es ryan isacsson"
 * ```
 *
 * The whole range is 0.15–0.43, because `EMBEDDING_DIMENSIONS` is **256** — reduced
 * from the model's 3072 — and cutting dimensions compresses similarity. A 0.62
 * threshold would have put every question in its own cluster and shipped as "the
 * clustering found no themes", with nothing anywhere looking wrong.
 *
 * 0.40 sits just under the one pair a person would also call the same theme
 * (leadership and strategy at 0.429) and above the next (0.287, colours and candidate
 * counts — unrelated). That is a boundary drawn from **seven** questions, which is not
 * enough to be confident about, so:
 *
 *   - it is overridable per run, so tuning needs no deploy;
 *   - `insight_themes.prompt_version` records which threshold produced a period, so a
 *     retune does not silently make two months incomparable.
 *
 * Revisit it once there are a few hundred questions. Expect to move it.
 */
export const DEFAULT_THRESHOLD = 0.4

/** A run will not label more clusters than this, so one bad night cannot spend. */
export const MAX_CLUSTERS_PER_RUN = 40

export interface ClusterItem {
  /** `chat_messages.id`. Also the sort key that makes a run reproducible. */
  readonly id: string
  /** Unit-length embedding. */
  readonly vector: readonly number[]
  /** Kept so a cluster can report how many distinct clients it spans (§2). */
  readonly clientId: string
}

export interface ClusterMember {
  readonly id: string
  /** Similarity to the cluster's centroid at the moment of assignment. */
  readonly similarity: number
}

export interface Cluster {
  readonly members: readonly ClusterMember[]
  readonly centroid: readonly number[]
  /** Distinct `clientId` values among the members — the k in k-anonymity. */
  readonly clientCount: number
}

/**
 * Dot product, which for unit vectors is the cosine.
 *
 * Returns 0 for mismatched lengths rather than throwing. A dimension change is a real
 * possibility — `question_embeddings` stores `dims` precisely because a model swap
 * would mix two vector spaces — and the caller filters on dimension before getting
 * here. Zero means "no similarity", which puts the odd vector in its own cluster
 * instead of crashing a nightly job.
 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0
  let total = 0
  for (let i = 0; i < a.length; i += 1) total += a[i] * b[i]
  return total
}

/** True when a vector is unit-length within floating-point tolerance. */
export function isUnitLength(vector: readonly number[]): boolean {
  let sumSquares = 0
  for (const value of vector) sumSquares += value * value
  return Math.abs(Math.sqrt(sumSquares) - 1) < 1e-6
}

/**
 * Assign each question to the nearest cluster above the threshold, or start a new one.
 *
 * Single pass, greedy, with the centroid updated as a running mean and re-normalised
 * so it stays comparable by dot product. `O(n · k)` with k the cluster count, which
 * for the volumes this product will see for years is nothing — and is measured in the
 * test rather than asserted here.
 *
 * **Nearest, not first-above-threshold.** The difference matters: taking the first
 * match makes the result depend on cluster creation order in a way that is much harder
 * to reason about, and produces visibly worse clusters when two themes are adjacent.
 */
export function clusterByThreshold(
  items: readonly ClusterItem[],
  threshold: number = DEFAULT_THRESHOLD,
): Cluster[] {
  // Sorted, so the greedy walk is reproducible. Without this the clusters depend on
  // whatever order the database happened to return, and §8's determinism question has
  // no good answer.
  const ordered = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  interface Building {
    members: ClusterMember[]
    /** Unnormalised running sum; the centroid is this scaled to unit length. */
    sum: number[]
    centroid: number[]
    clients: Set<string>
  }

  const clusters: Building[] = []

  for (const item of ordered) {
    let best: Building | null = null
    let bestSimilarity = threshold

    for (const cluster of clusters) {
      const similarity = cosine(item.vector, cluster.centroid)
      // `>` rather than `>=` on the running best, so an exact tie keeps the earlier
      // cluster — which, with the sort above, is itself deterministic.
      if (similarity > bestSimilarity) {
        best = cluster
        bestSimilarity = similarity
      }
    }

    if (best === null) {
      const sum = [...item.vector]
      clusters.push({
        members: [{ id: item.id, similarity: 1 }],
        sum,
        centroid: unit(sum),
        clients: new Set([item.clientId]),
      })
      continue
    }

    best.members.push({ id: item.id, similarity: round(bestSimilarity) })
    for (let i = 0; i < best.sum.length; i += 1) best.sum[i] += item.vector[i]
    best.centroid = unit(best.sum)
    best.clients.add(item.clientId)
  }

  // Largest first: a theme asked by nine people matters more than one asked once, and
  // the screen ranks by frequency × clients affected (§7 screen 3).
  return clusters
    .map((cluster) => ({
      members: cluster.members,
      centroid: cluster.centroid,
      clientCount: cluster.clients.size,
    }))
    .sort(
      (a, b) =>
        b.clientCount - a.clientCount ||
        b.members.length - a.members.length ||
        // Final tiebreak on the first member's id, so equal clusters still come back
        // in a fixed order.
        (a.members[0].id < b.members[0].id ? -1 : 1),
    )
}

function unit(vector: readonly number[]): number[] {
  let sumSquares = 0
  for (const value of vector) sumSquares += value * value
  const magnitude = Math.sqrt(sumSquares)
  if (magnitude === 0) return [...vector]
  return vector.map((value) => value / magnitude)
}

/**
 * Four decimals, which is what `insight_theme_members.similarity` (REAL) can hold.
 *
 * Rounded rather than truncated here — unlike the viewer's fit scale, where rounding
 * up overflowed a container. A similarity is a report, not a budget: nothing breaks if
 * 0.61999 is recorded as 0.62.
 */
function round(value: number): number {
  return Math.round(value * 10000) / 10000
}
