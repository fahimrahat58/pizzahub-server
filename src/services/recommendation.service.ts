import { ObjectId, type Document } from "mongodb";

import { collections } from "../config/database.js";
import { isValidObjectId } from "../utils/query.js";
import { menuItemDto } from "../utils/serialize.js";
import type { MenuItemDoc } from "../types/models.js";
import { menuWithRatingsPipeline } from "./menu.service.js";

/**
 * PizzaHub Taste DNA is a deterministic, explainable recommender built only
 * from the signed-in customer's own MongoDB activity. No external AI service
 * and no synthetic preference data are used.
 *
 * Scoring formula (0-100, clamped and rounded):
 *
 *   score = 15                                     // publicly available baseline
 *         + 30 * categoryScore / (categoryScore + 3)     // category affinity
 *         + 35 * ingredientScore / (ingredientScore + 4) // ingredient affinity
 *         + 20 * priceFit                                // historical budget fit
 *         -  8                                          // already purchased (soft)
 *
 * The saturating curves reward stronger real affinity (so 1-2 star reviews
 * genuinely lower scores) while keeping every term within its point budget.
 *
 * Signal weights: delivered order = 3 per unit (max 3 units), favorite = 2.5,
 * 4-5 star review = 2, 3 star review = 0.5 (neutral), 1-2 star review = -2.5.
 * Negative weights are subtracted from category/ingredient affinities, and a
 * pizza the customer rated 1-2 stars is never recommended directly.
 */

export const DEFAULT_TASTE_DNA_LIMIT = 8;
export const MAX_TASTE_DNA_LIMIT = 12;

const MAX_CANDIDATES = 400;
const ORDER_WEIGHT = 3;
const FAVORITE_WEIGHT = 2.5;
const POSITIVE_REVIEW_WEIGHT = 2;
const NEUTRAL_REVIEW_WEIGHT = 0.5;
const NEGATIVE_REVIEW_WEIGHT = 2.5;

const BASE_SCORE = 15;
const CATEGORY_POINTS = 30;
const INGREDIENT_POINTS = 35;
const BUDGET_POINTS = 20;
const REORDER_PENALTY = 8;
const CATEGORY_SATURATION = 3;
const INGREDIENT_SATURATION = 4;

const SPICE_PATTERN = /jalapeño|jalapeno|chili|chilli|spicy|pepper flake|sriracha/i;

export interface TasteScoreEntry {
  name: string;
  score: number;
  signals: number;
}

export interface TasteBudgetRange {
  min: number | null;
  max: number | null;
  label: string;
  sampleSize: number;
}

export interface TasteProfile {
  topCategories: TasteScoreEntry[];
  favoriteIngredients: TasteScoreEntry[];
  budgetRange: TasteBudgetRange;
  totalSignals: number;
  summary: string;
  status: "empty" | "developing" | "ready";
}

export interface TasteRecommendation {
  item: ReturnType<typeof menuItemDto>;
  matchScore: number;
  reasons: string[];
}

export interface TasteDnaResult {
  profile: TasteProfile;
  recommendations: TasteRecommendation[];
}

type ScoreMap = Map<string, TasteScoreEntry>;

type InternalBudget = TasteBudgetRange & { average: number };

type ScoredCandidate = {
  id: string;
  name: string;
  matchScore: number;
  purchased: boolean;
  reasons: string[];
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const round = (value: number): number => Math.round(value * 10) / 10;

const keyFor = (value: string): string => value.trim().toLocaleLowerCase();

const finitePrice = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

const toHex = (value: unknown): string | null => {
  if (value instanceof ObjectId) return value.toHexString();
  if (typeof value === "string" && isValidObjectId(value)) return value;
  return null;
};

const quantile = (sorted: number[], fraction: number): number => {
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
};

const addScore = (map: ScoreMap, name: string, weight: number): void => {
  const key = keyFor(name);
  if (!key) return;
  const current = map.get(key);
  if (current) {
    current.score += weight;
    current.signals += 1;
  } else {
    map.set(key, { name: name.trim(), score: weight, signals: 1 });
  }
};

/** Positive weights minus negative weights, dropping entries that net to zero. */
const netScores = (positive: ScoreMap, negative: ScoreMap, limit: number): TasteScoreEntry[] =>
  [...positive.entries()]
    .map(([key, entry]) => ({
      ...entry,
      score: round(Math.max(0, entry.score - (negative.get(key)?.score ?? 0))),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);

const budgetLabel = (average: number, catalogPrices: number[]): string => {
  if (new Set(catalogPrices).size < 3) return "Not enough data";
  const sorted = [...catalogPrices].sort((a, b) => a - b);
  if (average <= quantile(sorted, 1 / 3)) return "Budget-friendly";
  if (average <= quantile(sorted, 2 / 3)) return "Mid-range";
  return "Premium";
};

const buildBudget = (priceSamples: number[], catalogPrices: number[]): InternalBudget => {
  if (!priceSamples.length) {
    return { min: null, max: null, label: "Not enough purchase history", sampleSize: 0, average: 0 };
  }
  const sorted = [...priceSamples].sort((a, b) => a - b);
  const average = sorted.reduce((sum, price) => sum + price, 0) / sorted.length;
  return {
    min: round(quantile(sorted, 0.1)),
    max: round(quantile(sorted, 0.9)),
    label: budgetLabel(average, catalogPrices),
    sampleSize: sorted.length,
    average,
  };
};

const priceFit = (price: number, budget: InternalBudget): number => {
  if (!budget.sampleSize || budget.min == null || budget.max == null) return 0;
  if (price >= budget.min && price <= budget.max) return 1;
  const width = budget.max - budget.min;
  const reference = width > 0 ? width : Math.max(budget.max, 1);
  const distance = price < budget.min ? budget.min - price : price - budget.max;
  return clamp(1 - distance / reference, 0, 1);
};

const buildSummary = (
  categories: TasteScoreEntry[],
  ingredients: TasteScoreEntry[],
  budget: InternalBudget,
  hasOrders: boolean,
  totalSignals: number,
): string => {
  if (!totalSignals) {
    return "There isn't enough activity yet to build your taste profile.";
  }

  const parts: string[] = [];
  const lead = hasOrders ? "Your delivered orders" : "Your saved pizzas and reviews";

  if (categories.length) {
    const names = categories.slice(0, 2).map((entry) => entry.name);
    parts.push(`${lead} point toward ${names.join(" and ")} pizzas`);
  }
  if (ingredients.length) {
    parts.push(`${ingredients.slice(0, 3).map((entry) => entry.name).join(", ")} are your most frequent ingredients`);
  }
  if (budget.sampleSize && budget.label !== "Not enough data") {
    parts.push(`you usually choose ${budget.label.toLocaleLowerCase()} options around $${budget.average.toFixed(2)}`);
  }
  const spicy = ingredients.find((entry) => SPICE_PATTERN.test(entry.name));
  if (spicy) {
    parts.push(`you also favor ${spicy.name.toLocaleLowerCase()}`);
  }

  if (!parts.length) {
    return "Your saved activity is still too limited to describe a clear taste pattern.";
  }
  const sentence = parts.join("; ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
};

export const buildTasteDna = async (
  customerId: string,
  limit: number,
): Promise<TasteDnaResult> => {
  const orderFilter: Document = { customerId, status: "delivered" };
  const favoriteFilter: Document = { customerId };
  // Hidden reviews and restaurant-only reviews never influence pizza taste.
  const reviewFilter: Document = {
    customerId,
    menuItemId: { $type: "objectId" },
    isHidden: { $ne: true },
  };
  const publicFilter: Document = { approvalStatus: "approved", isActive: true };

  const [orders, favorites, reviews, candidates] = await Promise.all([
    collections
      .orders()
      .find(orderFilter, { projection: { menuItemId: 1, unitPrice: 1, quantity: 1 } })
      .toArray(),
    collections.favorites().find(favoriteFilter, { projection: { menuItemId: 1 } }).toArray(),
    collections.reviews().find(reviewFilter, { projection: { menuItemId: 1, rating: 1 } }).toArray(),
    collections
      .menuItems()
      .find(publicFilter, { sort: { isFeatured: -1, createdAt: -1 }, limit: MAX_CANDIDATES })
      .toArray(),
  ]);

  const referencedIds = new Set<string>();
  const collectId = (value: unknown): string | null => {
    const id = toHex(value);
    if (id) referencedIds.add(id);
    return id;
  };
  orders.forEach((order) => collectId(order.menuItemId));
  favorites.forEach((favorite) => collectId(favorite.menuItemId));
  reviews.forEach((review) => collectId(review.menuItemId));

  const historicalItems = referencedIds.size
    ? await collections
        .menuItems()
        .find({ _id: { $in: [...referencedIds].map((id) => new ObjectId(id)) } })
        .toArray()
    : [];
  const itemById = new Map(historicalItems.map((item) => [item._id.toHexString(), item]));

  const positiveCategories: ScoreMap = new Map();
  const negativeCategories: ScoreMap = new Map();
  const positiveIngredients: ScoreMap = new Map();
  const negativeIngredients: ScoreMap = new Map();
  const purchasedItems = new Set<string>();
  const dislikedItems = new Set<string>();
  const priceSamples: number[] = [];
  let totalSignals = 0;

  const addPreferences = (item: MenuItemDoc, weight: number, positive: boolean): void => {
    const categories = positive ? positiveCategories : negativeCategories;
    const ingredients = positive ? positiveIngredients : negativeIngredients;
    // Negative maps store positive magnitudes so netScores can subtract them.
    const magnitude = Math.abs(weight);
    addScore(categories, item.category, magnitude);
    for (const ingredient of item.ingredients ?? []) {
      addScore(ingredients, ingredient, magnitude);
    }
    totalSignals += 1;
  };

  for (const order of orders) {
    const id = toHex(order.menuItemId);
    const price = finitePrice(order.unitPrice);
    if (price != null) priceSamples.push(price);
    if (!id) continue;
    purchasedItems.add(id);
    const item = itemById.get(id);
    if (!item) continue; // deleted menu items must not crash the endpoint
    addPreferences(item, ORDER_WEIGHT * clamp(order.quantity || 1, 1, 3), true);
  }

  for (const favorite of favorites) {
    const id = toHex(favorite.menuItemId);
    if (!id) continue;
    const item = itemById.get(id);
    if (!item) continue;
    addPreferences(item, FAVORITE_WEIGHT, true);
  }

  for (const review of reviews) {
    const id = toHex(review.menuItemId);
    if (!id) continue;
    const rating = Number(review.rating);
    if (!Number.isFinite(rating)) continue;
    const item = itemById.get(id);
    if (!item) continue;
    if (rating >= 4) {
      addPreferences(item, POSITIVE_REVIEW_WEIGHT, true);
    } else if (rating === 3) {
      addPreferences(item, NEUTRAL_REVIEW_WEIGHT, true);
    } else {
      dislikedItems.add(id);
      addPreferences(item, -NEGATIVE_REVIEW_WEIGHT, false);
    }
  }

  const topCategories = netScores(positiveCategories, negativeCategories, 8);
  const favoriteIngredients = netScores(positiveIngredients, negativeIngredients, 10);
  const catalogPrices = candidates
    .map((item) => finitePrice(item.price))
    .filter((price): price is number => price != null);
  const budget = buildBudget(priceSamples, catalogPrices);

  const categoryScoreById = new Map(topCategories.map((entry) => [keyFor(entry.name), entry.score]));
  const ingredientScoreById = new Map(
    favoriteIngredients.map((entry) => [keyFor(entry.name), entry.score]),
  );

  const scored: ScoredCandidate[] = [];
  if (totalSignals > 0) {
    for (const candidate of candidates) {
      const id = candidate._id.toHexString();
      if (dislikedItems.has(id)) continue; // never directly recommend a 1-2 star pizza

      const categoryScore = categoryScoreById.get(keyFor(candidate.category)) ?? 0;
      const matchedIngredients = (candidate.ingredients ?? []).filter(
        (name) => (ingredientScoreById.get(keyFor(name)) ?? 0) > 0,
      );
      const ingredientScore = matchedIngredients.reduce(
        (sum, name) => sum + (ingredientScoreById.get(keyFor(name)) ?? 0),
        0,
      );
      const fit = priceFit(candidate.price, budget);

      let matchScore =
        BASE_SCORE +
        CATEGORY_POINTS * (categoryScore / (categoryScore + CATEGORY_SATURATION)) +
        INGREDIENT_POINTS * (ingredientScore / (ingredientScore + INGREDIENT_SATURATION)) +
        BUDGET_POINTS * fit;
      const purchased = purchasedItems.has(id);
      if (purchased) matchScore -= REORDER_PENALTY;

      const reasons: string[] = [];
      if (categoryScore > 0) {
        reasons.push(`You tend to enjoy ${candidate.category} pizzas`);
      }
      if (matchedIngredients.length) {
        reasons.push(`Includes ingredients you like: ${matchedIngredients.slice(0, 3).join(", ")}`);
      }
      if (budget.min != null && budget.max != null && fit >= 0.6) {
        reasons.push(`Fits your usual price range ($${budget.min.toFixed(2)}-$${budget.max.toFixed(2)})`);
      }
      if (!reasons.length) continue; // every recommendation must be explainable

      scored.push({
        id,
        name: candidate.name,
        matchScore: Math.round(clamp(matchScore, 0, 100)),
        purchased,
        reasons,
      });
    }
  }

  scored.sort(
    (a, b) =>
      b.matchScore - a.matchScore ||
      Number(a.purchased) - Number(b.purchased) ||
      a.name.localeCompare(b.name),
  );
  const selected = scored.slice(0, clamp(limit, 1, MAX_TASTE_DNA_LIMIT));

  let recommendations: TasteRecommendation[] = [];
  if (selected.length) {
    const enriched = await collections
      .menuItems()
      .aggregate<MenuItemDoc>(
        menuWithRatingsPipeline(
          {
            ...publicFilter,
            _id: { $in: selected.map((entry) => new ObjectId(entry.id)) },
          },
          {},
          0,
          selected.length,
        ),
      )
      .toArray();
    const enrichedById = new Map(
      enriched.map((item) => [item._id.toHexString(), menuItemDto(item, item)]),
    );
    recommendations = selected.flatMap((entry) => {
      const item = enrichedById.get(entry.id);
      return item ? [{ item, matchScore: entry.matchScore, reasons: entry.reasons }] : [];
    });
  }

  const status: TasteProfile["status"] =
    totalSignals === 0 ? "empty" : orders.length === 0 ? "developing" : "ready";

  return {
    profile: {
      topCategories,
      favoriteIngredients,
      budgetRange: {
        min: budget.min,
        max: budget.max,
        label: budget.label,
        sampleSize: budget.sampleSize,
      },
      totalSignals,
      summary: buildSummary(topCategories, favoriteIngredients, budget, orders.length > 0, totalSignals),
      status,
    },
    recommendations,
  };
};
