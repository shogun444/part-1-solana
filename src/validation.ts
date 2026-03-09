import { z } from "zod";

const positiveInt = z.coerce.number().int().positive();
const positiveNumber = z.coerce.number().positive();

const tierSchema = z
  .object({
    minAmount: z.coerce.number().int().nonnegative(),
    maxAmount: positiveInt,
    pricePerToken: positiveNumber,
  })
  .refine((tier) => tier.maxAmount > tier.minAmount, {
    message: "Invalid tier range",
  });

const vestingSchema = z.object({
  cliffDays: z.coerce.number().int().nonnegative(),
  vestingDays: z.coerce.number().int().nonnegative(),
  tgePercent: z.coerce.number().int().min(0).max(100),
});

export const registerSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
  name: z.string().trim().min(1),
});

export const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export const createLaunchSchema = z
  .object({
    name: z.string().trim().min(1),
    symbol: z.string().trim().min(1),
    totalSupply: positiveInt,
    pricePerToken: positiveNumber,
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    maxPerWallet: positiveInt,
    description: z.string().trim().nullable().optional(),
    tiers: z.array(tierSchema).optional(),
    vesting: vestingSchema.optional(),
  })
  .refine((data) => data.endsAt > data.startsAt, {
    message: "endsAt must be after startsAt",
  });

export const updateLaunchSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    symbol: z.string().trim().min(1).optional(),
    totalSupply: positiveInt.optional(),
    pricePerToken: positiveNumber.optional(),
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().optional(),
    maxPerWallet: positiveInt.optional(),
    description: z.string().trim().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  })
  .refine(
    (data) =>
      !data.startsAt ||
      !data.endsAt ||
      data.endsAt.getTime() > data.startsAt.getTime(),
    {
      message: "endsAt must be after startsAt",
    },
  );

export const addWhitelistSchema = z.object({
  addresses: z.array(z.string().trim().min(1)).min(1),
});

export const createReferralSchema = z.object({
  code: z.string().trim().min(1),
  discountPercent: z.coerce.number().int().min(0).max(100),
  maxUses: positiveInt,
});

export const purchaseTokensSchema = z.object({
  walletAddress: z.string().trim().min(1),
  amount: positiveInt,
  txSignature: z.string().trim().min(1),
  referralCode: z.string().trim().min(1).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateLaunchInput = z.infer<typeof createLaunchSchema>;
export type UpdateLaunchInput = z.infer<typeof updateLaunchSchema>;
export type AddWhitelistInput = z.infer<typeof addWhitelistSchema>;
export type CreateReferralInput = z.infer<typeof createReferralSchema>;
export type PurchaseTokensInput = z.infer<typeof purchaseTokensSchema>;
