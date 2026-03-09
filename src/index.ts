import express, { Request, Response, NextFunction } from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import bcryptjs from "bcryptjs";
import { z } from "zod";
import {
  addWhitelistSchema,
  createLaunchSchema,
  createReferralSchema,
  loginSchema,
  purchaseTokensSchema,
  registerSchema,
  updateLaunchSchema,
} from "./validation";

const app = express();
const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET || "your-secret-key";

app.use(express.json());

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface AuthRequest extends Request {
  user?: { id: string; email: string };
}

interface LaunchWithStatus {
  id: string;
  creatorId: string;
  name: string;
  symbol: string;
  totalSupply: number;
  pricePerToken: number;
  startsAt: Date;
  endsAt: Date;
  maxPerWallet: number;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  status: "UPCOMING" | "ACTIVE" | "ENDED" | "SOLD_OUT";
  tiers?: Array<{
    id: string;
    minAmount: number;
    maxAmount: number;
    pricePerToken: number;
  }>;
  vestingConfig?: {
    id: string;
    cliffDays: number;
    vestingDays: number;
    tgePercent: number;
  } | null;
}

type LaunchStatus = "UPCOMING" | "ACTIVE" | "ENDED" | "SOLD_OUT";

interface PurchaseAmount {
  amount: number;
}

interface TierInput {
  minAmount: number;
  maxAmount: number;
  pricePerToken: number;
}

interface LaunchWithRelations {
  id: string;
  creatorId: string;
  name: string;
  symbol: string;
  totalSupply: number;
  pricePerToken: number;
  startsAt: Date;
  endsAt: Date;
  maxPerWallet: number;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
  tiers: Array<{
    id: string;
    minAmount: number;
    maxAmount: number;
    pricePerToken: number;
  }>;
  vestingConfig: {
    id: string;
    cliffDays: number;
    vestingDays: number;
    tgePercent: number;
  } | null;
  purchases: PurchaseAmount[];
}

// ============================================================================
// MIDDLEWARE
// ============================================================================

const authMiddleware = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid token" });
  }

  const token = authHeader.substring(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as {
      id: string;
      email: string;
    };
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Missing or invalid token" });
  }
};

const parseBody = <T>(
  schema: z.ZodType<T>,
  body: unknown,
): { success: true; data: T } | { success: false } => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { success: false };
  }
  return { success: true, data: parsed.data };
};

// Helper function to compute launch status
const computeStatus = (launch: {
  startsAt: Date;
  endsAt: Date;
  totalSupply: number;
  totalPurchased: number;
}): LaunchStatus => {
  const now = new Date();
  if (launch.totalPurchased >= launch.totalSupply) return "SOLD_OUT";
  if (now < launch.startsAt) return "UPCOMING";
  if (now > launch.endsAt) return "ENDED";
  return "ACTIVE";
};

const mapLaunchWithStatus = (launch: LaunchWithRelations): LaunchWithStatus => {
  const totalPurchased = launch.purchases.reduce(
    (sum, purchase) => sum + purchase.amount,
    0,
  );
  const status = computeStatus({
    startsAt: launch.startsAt,
    endsAt: launch.endsAt,
    totalSupply: launch.totalSupply,
    totalPurchased,
  });

  return {
    id: launch.id,
    creatorId: launch.creatorId,
    name: launch.name,
    symbol: launch.symbol,
    totalSupply: launch.totalSupply,
    pricePerToken: launch.pricePerToken,
    startsAt: launch.startsAt,
    endsAt: launch.endsAt,
    maxPerWallet: launch.maxPerWallet,
    description: launch.description,
    createdAt: launch.createdAt,
    updatedAt: launch.updatedAt,
    status,
    tiers: launch.tiers,
    vestingConfig: launch.vestingConfig,
  };
};

const calculateTieredCost = (
  purchaseAmount: number,
  alreadySold: number,
  tiers: TierInput[],
  basePricePerToken: number,
): number => {
  if (tiers.length === 0) {
    return purchaseAmount * basePricePerToken;
  }

  let remaining = purchaseAmount;
  let runningSold = alreadySold;
  let totalCost = 0;

  for (const tier of tiers) {
    if (remaining <= 0) {
      break;
    }

    if (runningSold >= tier.maxAmount) {
      continue;
    }

    const filledInTier = Math.max(runningSold, tier.minAmount);
    const tierRemainingCapacity = Math.max(0, tier.maxAmount - filledInTier);
    if (tierRemainingCapacity === 0) {
      continue;
    }

    const tokensInTier = Math.min(remaining, tierRemainingCapacity);
    totalCost += tokensInTier * tier.pricePerToken;
    remaining -= tokensInTier;
    runningSold += tokensInTier;
  }

  if (remaining > 0) {
    totalCost += remaining * basePricePerToken;
  }

  return totalCost;
};

const computeVestingState = (params: {
  totalPurchased: number;
  firstPurchaseTime: Date;
  cliffDays: number;
  vestingDays: number;
  tgePercent: number;
}) => {
  const {
    totalPurchased,
    firstPurchaseTime,
    cliffDays,
    vestingDays,
    tgePercent,
  } = params;

  const tgeAmount = Math.floor((totalPurchased * tgePercent) / 100);
  const cliffEndsAt = new Date(
    firstPurchaseTime.getTime() + cliffDays * 24 * 60 * 60 * 1000,
  );
  const now = new Date();

  let claimableAmount = tgeAmount;
  if (now >= cliffEndsAt) {
    if (vestingDays <= 0) {
      claimableAmount = totalPurchased;
    } else {
      const vestingDurationMs = vestingDays * 24 * 60 * 60 * 1000;
      const elapsedMs = Math.max(0, now.getTime() - cliffEndsAt.getTime());
      const linearProgress = Math.min(1, elapsedMs / vestingDurationMs);
      const linearUnlocked = Math.floor(
        (totalPurchased - tgeAmount) * linearProgress,
      );
      claimableAmount = tgeAmount + linearUnlocked;
    }
  }

  claimableAmount = Math.min(totalPurchased, Math.max(0, claimableAmount));
  const lockedAmount = totalPurchased - claimableAmount;

  return {
    tgeAmount,
    cliffEndsAt,
    vestedAmount: claimableAmount,
    claimableAmount,
    lockedAmount,
  };
};

// Helper function to get total purchased for a launch
const getTotalPurchased = async (launchId: string): Promise<number> => {
  const result = await prisma.purchase.aggregate({
    where: { launchId },
    _sum: { amount: true },
  });
  return result._sum.amount || 0;
};

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get("/api/health", (req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

// ============================================================================
// AUTHENTICATION ENDPOINTS
// ============================================================================

app.post("/api/auth/register", async (req: Request, res: Response) => {
  const parsed = parseBody(registerSchema, req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const { email, password, name } = parsed.data;

  try {
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(409).json({ error: "Duplicate email" });
    }

    const hashedPassword = await bcryptjs.hash(password, 10);
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
      },
    });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, {
      expiresIn: "7d",
    });

    res.status(201).json({
      token,
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/api/auth/login", async (req: Request, res: Response) => {
  const parsed = parseBody(loginSchema, req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const { email, password } = parsed.data;

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const passwordMatch = await bcryptjs.compare(password, user.password);
    if (!passwordMatch) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, {
      expiresIn: "7d",
    });

    res.status(200).json({
      token,
      user: { id: user.id, email: user.email, name: user.name },
    });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// LAUNCH ENDPOINTS
// ============================================================================

app.post(
  "/api/launches",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    const parsed = parseBody(createLaunchSchema, req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid input" });
    }

    const {
      name,
      symbol,
      totalSupply,
      pricePerToken,
      startsAt,
      endsAt,
      maxPerWallet,
      description,
      tiers,
      vesting,
    } = parsed.data;

    try {
      const launch = await prisma.launch.create({
        data: {
          name,
          symbol,
          totalSupply,
          pricePerToken,
          startsAt,
          endsAt,
          maxPerWallet,
          description: description || null,
          creatorId: req.user!.id,
        },
      });

      if (tiers && Array.isArray(tiers)) {
        for (const tier of tiers) {
          await prisma.tier.create({
            data: {
              launchId: launch.id,
              minAmount: tier.minAmount,
              maxAmount: tier.maxAmount,
              pricePerToken: tier.pricePerToken,
            },
          });
        }
      }

      if (vesting) {
        await prisma.vestingConfig.create({
          data: {
            launchId: launch.id,
            cliffDays: vesting.cliffDays,
            vestingDays: vesting.vestingDays,
            tgePercent: vesting.tgePercent,
          },
        });
      }

      const status = computeStatus({
        startsAt: launch.startsAt,
        endsAt: launch.endsAt,
        totalSupply: launch.totalSupply,
        totalPurchased: 0,
      });

      const responseData = {
        ...launch,
        status,
        tiers: tiers || [],
        vestingConfig: vesting || null,
      };

      res.status(201).json(responseData);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

app.get("/api/launches", async (req: Request, res: Response) => {
  const page = parseInt((req.query.page as string) || "1", 10);
  const limit = parseInt((req.query.limit as string) || "10", 10);
  const rawStatusFilter = req.query.status as string | undefined;

  if (
    !Number.isInteger(page) ||
    !Number.isInteger(limit) ||
    page <= 0 ||
    limit <= 0
  ) {
    return res.status(400).json({ error: "Invalid input" });
  }

  const skip = (page - 1) * limit;
  const validStatuses: LaunchStatus[] = [
    "UPCOMING",
    "ACTIVE",
    "ENDED",
    "SOLD_OUT",
  ];
  const hasStatusQuery = rawStatusFilter !== undefined;
  const statusFilter = validStatuses.includes(rawStatusFilter as LaunchStatus)
    ? (rawStatusFilter as LaunchStatus)
    : null;

  try {
    const launches = (await prisma.launch.findMany({
      include: {
        tiers: true,
        vestingConfig: true,
        purchases: { select: { amount: true } },
      },
      orderBy: { createdAt: "desc" },
    })) as LaunchWithRelations[];

    const launchesWithStatus: LaunchWithStatus[] =
      launches.map(mapLaunchWithStatus);

    const filtered = hasStatusQuery
      ? statusFilter
        ? launchesWithStatus.filter((launch) => launch.status === statusFilter)
        : []
      : launchesWithStatus;

    const total = filtered.length;
    const paged = filtered.slice(skip, skip + limit);

    res.status(200).json({
      launches: paged,
      total,
      page,
      limit,
    });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

app.get("/api/launches/:id", async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const launch = (await prisma.launch.findUnique({
      where: { id },
      include: {
        tiers: true,
        vestingConfig: true,
        purchases: { select: { amount: true } },
      },
    })) as LaunchWithRelations | null;

    if (!launch) {
      return res.status(404).json({ error: "Launch not found" });
    }

    const response: LaunchWithStatus = mapLaunchWithStatus(launch);

    res.status(200).json(response);
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

app.put(
  "/api/launches/:id",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const parsed = parseBody(updateLaunchSchema, req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid input" });
    }

    const {
      name,
      symbol,
      totalSupply,
      pricePerToken,
      startsAt,
      endsAt,
      maxPerWallet,
      description,
    } = parsed.data;

    try {
      const launch = await prisma.launch.findUnique({
        where: { id },
        include: {
          tiers: true,
          vestingConfig: true,
          purchases: { select: { amount: true } },
        },
      });

      if (!launch) {
        return res.status(404).json({ error: "Launch not found" });
      }

      if (launch.creatorId !== req.user!.id) {
        return res.status(403).json({ error: "Not creator" });
      }

      const effectiveStartsAt = startsAt ?? launch.startsAt;
      const effectiveEndsAt = endsAt ?? launch.endsAt;
      if (effectiveEndsAt <= effectiveStartsAt) {
        return res.status(400).json({ error: "Invalid input" });
      }

      const updated = await prisma.launch.update({
        where: { id },
        data: {
          name: name !== undefined ? name : launch.name,
          symbol: symbol !== undefined ? symbol : launch.symbol,
          totalSupply:
            totalSupply !== undefined ? totalSupply : launch.totalSupply,
          pricePerToken:
            pricePerToken !== undefined ? pricePerToken : launch.pricePerToken,
          startsAt: effectiveStartsAt,
          endsAt: effectiveEndsAt,
          maxPerWallet:
            maxPerWallet !== undefined ? maxPerWallet : launch.maxPerWallet,
          description:
            description !== undefined ? description : launch.description,
        },
      });

      const totalPurchased = launch.purchases.reduce(
        (sum, purchase) => sum + purchase.amount,
        0,
      );
      const status = computeStatus({
        ...updated,
        totalPurchased,
      });

      const response: LaunchWithStatus = {
        id: updated.id,
        creatorId: updated.creatorId,
        name: updated.name,
        symbol: updated.symbol,
        totalSupply: updated.totalSupply,
        pricePerToken: updated.pricePerToken,
        startsAt: updated.startsAt,
        endsAt: updated.endsAt,
        maxPerWallet: updated.maxPerWallet,
        description: updated.description,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        status,
        tiers: launch.tiers,
        vestingConfig: launch.vestingConfig,
      };

      res.status(200).json(response);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ============================================================================
// WHITELIST ENDPOINTS
// ============================================================================

app.post(
  "/api/launches/:id/whitelist",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const parsed = parseBody(addWhitelistSchema, req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid input" });
    }

    const { addresses } = parsed.data;

    try {
      const launch = await prisma.launch.findUnique({ where: { id } });
      if (!launch) {
        return res.status(404).json({ error: "Launch not found" });
      }

      if (launch.creatorId !== req.user!.id) {
        return res.status(403).json({ error: "Not creator" });
      }

      const existing = await prisma.whitelistEntry.findMany({
        where: { launchId: id },
        select: { address: true },
      });
      const existingAddresses = new Set(existing.map((entry) => entry.address));
      const uniqueIncoming = Array.from(
        new Set(addresses.map((address) => address.trim()).filter(Boolean)),
      );
      const newAddresses = uniqueIncoming.filter(
        (address) => !existingAddresses.has(address),
      );

      if (newAddresses.length > 0) {
        await prisma.whitelistEntry.createMany({
          data: newAddresses.map((address) => ({ launchId: id, address })),
          skipDuplicates: true,
        });
      }

      const added = newAddresses.length;
      const total = existingAddresses.size + added;
      res.status(200).json({ added, total });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

app.get(
  "/api/launches/:id/whitelist",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    const { id } = req.params;

    try {
      const launch = await prisma.launch.findUnique({ where: { id } });
      if (!launch) {
        return res.status(404).json({ error: "Launch not found" });
      }

      if (launch.creatorId !== req.user!.id) {
        return res.status(403).json({ error: "Not creator" });
      }

      const whitelistEntries = await prisma.whitelistEntry.findMany({
        where: { launchId: id },
      });

      res.status(200).json({
        addresses: whitelistEntries.map((entry) => entry.address),
        total: whitelistEntries.length,
      });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

app.delete(
  "/api/launches/:id/whitelist/:address",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    const { id, address } = req.params;

    try {
      const launch = await prisma.launch.findUnique({ where: { id } });
      if (!launch) {
        return res.status(404).json({ error: "Launch not found" });
      }

      if (launch.creatorId !== req.user!.id) {
        return res.status(403).json({ error: "Not creator" });
      }

      const deleted = await prisma.whitelistEntry.deleteMany({
        where: { launchId: id, address },
      });

      if (deleted.count === 0) {
        return res
          .status(404)
          .json({ error: "Address not found in whitelist" });
      }

      res.status(200).json({ removed: true });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ============================================================================
// REFERRAL CODE ENDPOINTS
// ============================================================================

app.post(
  "/api/launches/:id/referrals",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const parsed = parseBody(createReferralSchema, req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid input" });
    }

    const { code, discountPercent, maxUses } = parsed.data;

    try {
      const launch = await prisma.launch.findUnique({ where: { id } });
      if (!launch) {
        return res.status(404).json({ error: "Launch not found" });
      }

      if (launch.creatorId !== req.user!.id) {
        return res.status(403).json({ error: "Not creator" });
      }

      const existing = await prisma.referralCode.findUnique({
        where: { launchId_code: { launchId: id, code } },
      });
      if (existing) {
        return res
          .status(409)
          .json({ error: "Duplicate code for this launch" });
      }

      const referral = await prisma.referralCode.create({
        data: {
          launchId: id,
          code,
          discountPercent,
          maxUses,
          usedCount: 0,
        },
      });

      res.status(201).json({
        id: referral.id,
        code: referral.code,
        discountPercent: referral.discountPercent,
        maxUses: referral.maxUses,
        usedCount: referral.usedCount,
      });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

app.get(
  "/api/launches/:id/referrals",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    const { id } = req.params;

    try {
      const launch = await prisma.launch.findUnique({ where: { id } });
      if (!launch) {
        return res.status(404).json({ error: "Launch not found" });
      }

      if (launch.creatorId !== req.user!.id) {
        return res.status(403).json({ error: "Not creator" });
      }

      const referrals = await prisma.referralCode.findMany({
        where: { launchId: id },
      });

      res.status(200).json(referrals);
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ============================================================================
// PURCHASE ENDPOINTS
// ============================================================================

app.post(
  "/api/launches/:id/purchase",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const parsed = parseBody(purchaseTokensSchema, req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid input" });
    }

    const { walletAddress, amount, txSignature, referralCode } = parsed.data;

    try {
      const launch = await prisma.launch.findUnique({
        where: { id },
        include: { tiers: { orderBy: { minAmount: "asc" } }, purchases: true },
      });

      if (!launch) {
        return res.status(404).json({ error: "Launch not found" });
      }

      // Check launch status
      const alreadySold = await getTotalPurchased(id);
      const status = computeStatus({
        startsAt: launch.startsAt,
        endsAt: launch.endsAt,
        totalSupply: launch.totalSupply,
        totalPurchased: alreadySold,
      });

      if (status !== "ACTIVE") {
        return res.status(400).json({
          error: `Launch is ${status}, only ACTIVE launches can accept purchases`,
        });
      }

      // Check whitelist
      const whitelist = await prisma.whitelistEntry.findMany({
        where: { launchId: id },
      });

      if (whitelist.length > 0) {
        const isWhitelisted = whitelist.some(
          (entry) => entry.address === walletAddress,
        );
        if (!isWhitelisted) {
          return res
            .status(400)
            .json({ error: "Wallet address not whitelisted" });
        }
      }

      // Check sybil protection (max per user, not per wallet)
      const userPurchases = await prisma.purchase.aggregate({
        where: { launchId: id, userId: req.user!.id },
        _sum: { amount: true },
      });
      const userTotalPurchased = userPurchases._sum.amount || 0;

      if (userTotalPurchased + amount > launch.maxPerWallet) {
        return res.status(400).json({
          error: `Exceeds maxPerWallet limit. Current: ${userTotalPurchased}, requested: ${amount}, max: ${launch.maxPerWallet}`,
        });
      }

      // Check total supply
      if (alreadySold + amount > launch.totalSupply) {
        return res.status(400).json({ error: "Exceeds total supply" });
      }

      // Check for duplicate txSignature
      const existingPurchase = await prisma.purchase.findUnique({
        where: { txSignature },
      });
      if (existingPurchase) {
        return res
          .status(400)
          .json({ error: "Duplicate transaction signature" });
      }

      // Calculate cost with tiered pricing
      const totalCost = calculateTieredCost(
        amount,
        alreadySold,
        launch.tiers,
        launch.pricePerToken,
      );

      // Apply referral discount
      let finalCost = totalCost;
      let referralCodeId: string | null = null;
      let referralMaxUses: number | null = null;

      if (referralCode) {
        const refCode = await prisma.referralCode.findUnique({
          where: { launchId_code: { launchId: id, code: referralCode } },
        });

        if (!refCode) {
          return res.status(400).json({ error: "Invalid referral code" });
        }

        if (refCode.usedCount >= refCode.maxUses) {
          return res.status(400).json({ error: "Referral code exhausted" });
        }

        const discount = Math.floor(
          (totalCost * refCode.discountPercent) / 100,
        );
        finalCost = totalCost - discount;
        referralCodeId = refCode.id;
        referralMaxUses = refCode.maxUses;
      }

      const purchase = referralCodeId
        ? await prisma.$transaction(async (tx) => {
            const updated = await tx.referralCode.updateMany({
              where: {
                id: referralCodeId,
                usedCount: { lt: referralMaxUses! },
              },
              data: { usedCount: { increment: 1 } },
            });

            if (updated.count === 0) {
              throw new Error("REFERRAL_EXHAUSTED");
            }

            return tx.purchase.create({
              data: {
                launchId: id,
                userId: req.user!.id,
                walletAddress,
                amount,
                totalCost: finalCost,
                txSignature,
                referralCodeId,
              },
            });
          })
        : await prisma.purchase.create({
            data: {
              launchId: id,
              userId: req.user!.id,
              walletAddress,
              amount,
              totalCost: finalCost,
              txSignature,
              referralCodeId,
            },
          });

      res.status(201).json(purchase);
    } catch (error) {
      if (error instanceof Error && error.message === "REFERRAL_EXHAUSTED") {
        return res.status(400).json({ error: "Referral code exhausted" });
      }
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

app.get(
  "/api/launches/:id/purchases",
  authMiddleware,
  async (req: AuthRequest, res: Response) => {
    const { id } = req.params;

    try {
      const launch = await prisma.launch.findUnique({ where: { id } });
      if (!launch) {
        return res.status(404).json({ error: "Launch not found" });
      }

      let purchases;
      let total;

      if (launch.creatorId === req.user!.id) {
        // Creator sees all purchases
        purchases = await prisma.purchase.findMany({
          where: { launchId: id },
          orderBy: { createdAt: "desc" },
        });
        total = purchases.length;
      } else {
        // Other users see only their own
        purchases = await prisma.purchase.findMany({
          where: { launchId: id, userId: req.user!.id },
          orderBy: { createdAt: "desc" },
        });
        total = purchases.length;
      }

      res.status(200).json({ purchases, total });
    } catch (error) {
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ============================================================================
// VESTING ENDPOINTS
// ============================================================================

app.get("/api/launches/:id/vesting", async (req: Request, res: Response) => {
  const { id } = req.params;
  const { walletAddress } = req.query;

  if (!walletAddress || typeof walletAddress !== "string") {
    return res.status(400).json({ error: "Missing or invalid walletAddress" });
  }

  try {
    const launch = await prisma.launch.findUnique({
      where: { id },
      include: { vestingConfig: true, purchases: true },
    });

    if (!launch) {
      return res.status(404).json({ error: "Launch not found" });
    }

    // Get all purchases by this wallet for this launch
    const purchases = await prisma.purchase.findMany({
      where: { launchId: id, walletAddress },
    });

    const totalPurchased = purchases.reduce(
      (sum, purchase) => sum + purchase.amount,
      0,
    );

    if (!launch.vestingConfig) {
      // No vesting: all tokens claimable immediately
      res.status(200).json({
        totalPurchased,
        tgeAmount: totalPurchased,
        cliffEndsAt: new Date(),
        vestedAmount: totalPurchased,
        lockedAmount: 0,
        claimableAmount: totalPurchased,
      });
      return;
    }

    const vesting = launch.vestingConfig;
    const firstPurchaseTime =
      purchases.length > 0 ? purchases[0].createdAt : new Date();
    const {
      tgeAmount,
      cliffEndsAt,
      vestedAmount,
      lockedAmount,
      claimableAmount,
    } = computeVestingState({
      totalPurchased,
      firstPurchaseTime,
      cliffDays: vesting.cliffDays,
      vestingDays: vesting.vestingDays,
      tgePercent: vesting.tgePercent,
    });

    res.status(200).json({
      totalPurchased,
      tgeAmount,
      cliffEndsAt,
      vestedAmount,
      lockedAmount,
      claimableAmount,
    });
  } catch (error) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
