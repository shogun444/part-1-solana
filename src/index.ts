import express, { Request, Response, NextFunction } from "express";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import bcryptjs from "bcryptjs";

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
    return res.status(401).json({ error: "Invalid token" });
  }
};

// Helper function to compute launch status
const computeStatus = (launch: {
  startsAt: Date;
  endsAt: Date;
  totalSupply: number;
  totalPurchased: number;
}): "UPCOMING" | "ACTIVE" | "ENDED" | "SOLD_OUT" => {
  const now = new Date();
  if (launch.totalPurchased >= launch.totalSupply) return "SOLD_OUT";
  if (now < launch.startsAt) return "UPCOMING";
  if (now > launch.endsAt) return "ENDED";
  return "ACTIVE";
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
  const { email, password, name } = req.body;

  if (!email || !password || !name) {
    return res.status(400).json({ error: "Missing required fields" });
  }

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
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Missing required fields" });
  }

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
    } = req.body;

    const requiredFields = [
      name,
      symbol,
      totalSupply,
      pricePerToken,
      startsAt,
      endsAt,
      maxPerWallet,
    ];
    if (requiredFields.some((field) => field === undefined || field === null)) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    try {
      const launch = await prisma.launch.create({
        data: {
          name,
          symbol,
          totalSupply: parseInt(totalSupply),
          pricePerToken: parseFloat(pricePerToken),
          startsAt: new Date(startsAt),
          endsAt: new Date(endsAt),
          maxPerWallet: parseInt(maxPerWallet),
          description: description || null,
          creatorId: req.user!.id,
        },
      });

      if (tiers && Array.isArray(tiers)) {
        for (const tier of tiers) {
          await prisma.tier.create({
            data: {
              launchId: launch.id,
              minAmount: parseInt(tier.minAmount),
              maxAmount: parseInt(tier.maxAmount),
              pricePerToken: parseFloat(tier.pricePerToken),
            },
          });
        }
      }

      if (vesting) {
        await prisma.vestingConfig.create({
          data: {
            launchId: launch.id,
            cliffDays: parseInt(vesting.cliffDays),
            vestingDays: parseInt(vesting.vestingDays),
            tgePercent: parseInt(vesting.tgePercent),
          },
        });
      }

      const responseData = {
        ...launch,
        status: "UPCOMING" as const,
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
  const statusFilter = req.query.status as string | undefined;

  const skip = (page - 1) * limit;

  try {
    const launches = await prisma.launch.findMany({
      include: {
        tiers: true,
        vestingConfig: true,
        purchases: { select: { amount: true } },
      },
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
    });

    const total = await prisma.launch.count();

    const launchesWithStatus: LaunchWithStatus[] = launches
      .map((launch : any) => {
        const totalPurchased = launch.purchases.reduce(
          (sum: number, p : any)  => sum + p.amount,
          0,
        );
        const status = computeStatus({
          ...launch,
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
      })
      .filter((launch : any) => !statusFilter || launch.status === statusFilter);

    res.status(200).json({
      launches: launchesWithStatus,
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

    const totalPurchased = launch.purchases.reduce(
      (sum: number, p : any) => sum + p.amount,
      0,
    );
    const status = computeStatus({
      ...launch,
      totalPurchased,
    });

    const response: LaunchWithStatus = {
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
    const {
      name,
      symbol,
      totalSupply,
      pricePerToken,
      startsAt,
      endsAt,
      maxPerWallet,
      description,
    } = req.body;

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
        return res.status(403).json({ error: "Unauthorized" });
      }

      const updated = await prisma.launch.update({
        where: { id },
        data: {
          name: name !== undefined ? name : launch.name,
          symbol: symbol !== undefined ? symbol : launch.symbol,
          totalSupply:
            totalSupply !== undefined
              ? parseInt(totalSupply)
              : launch.totalSupply,
          pricePerToken:
            pricePerToken !== undefined
              ? parseFloat(pricePerToken)
              : launch.pricePerToken,
          startsAt:
            startsAt !== undefined ? new Date(startsAt) : launch.startsAt,
          endsAt: endsAt !== undefined ? new Date(endsAt) : launch.endsAt,
          maxPerWallet:
            maxPerWallet !== undefined
              ? parseInt(maxPerWallet)
              : launch.maxPerWallet,
          description:
            description !== undefined ? description : launch.description,
        },
      });

      const totalPurchased = launch.purchases.reduce(
        (sum: number, p : any) => sum + p.amount,
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
    const { addresses } = req.body;

    if (!addresses || !Array.isArray(addresses)) {
      return res.status(400).json({ error: "Invalid addresses" });
    }

    try {
      const launch = await prisma.launch.findUnique({ where: { id } });
      if (!launch) {
        return res.status(404).json({ error: "Launch not found" });
      }

      if (launch.creatorId !== req.user!.id) {
        return res.status(403).json({ error: "Unauthorized" });
      }

      const existing = await prisma.whitelistEntry.findMany({
        where: { launchId: id },
        select: { address: true },
      });
      const existingAddresses = new Set(existing.map((e : any) => e.address));

      let added = 0;
      for (const address of addresses) {
        if (!existingAddresses.has(address)) {
          await prisma.whitelistEntry.create({
            data: { launchId: id, address },
          });
          added++;
        }
      }

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
        return res.status(403).json({ error: "Unauthorized" });
      }

      const whitelistEntries = await prisma.whitelistEntry.findMany({
        where: { launchId: id },
      });

      res.status(200).json({
        addresses: whitelistEntries.map((e : any) => e.address),
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
        return res.status(403).json({ error: "Unauthorized" });
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
    const { code, discountPercent, maxUses } = req.body;

    if (!code || discountPercent === undefined || maxUses === undefined) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    try {
      const launch = await prisma.launch.findUnique({ where: { id } });
      if (!launch) {
        return res.status(404).json({ error: "Launch not found" });
      }

      if (launch.creatorId !== req.user!.id) {
        return res.status(403).json({ error: "Unauthorized" });
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
          discountPercent: parseInt(discountPercent),
          maxUses: parseInt(maxUses),
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
        return res.status(403).json({ error: "Unauthorized" });
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
    const { walletAddress, amount, txSignature, referralCode } = req.body;

    if (!walletAddress || !amount || !txSignature) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    try {
      const launch = await prisma.launch.findUnique({
        where: { id },
        include: { tiers: { orderBy: { minAmount: "asc" } }, purchases: true },
      });

      if (!launch) {
        return res.status(404).json({ error: "Launch not found" });
      }

      // Check launch status
      const totalPurchased = launch.purchases.reduce(
        (sum : number, p : any) => sum + p.amount,
        0,
      );
      const status = computeStatus({ ...launch, totalPurchased });

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
          (w : any) => w.address === walletAddress,
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
      if (totalPurchased + amount > launch.totalSupply) {
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
      let totalCost = 0;
      let remaining = amount;

      if (launch.tiers && launch.tiers.length > 0) {
        for (const tier of launch.tiers) {
          if (remaining <= 0) break;

          const capacity = tier.maxAmount - tier.minAmount;
          const toFillInTier = Math.min(remaining, capacity);
          totalCost += toFillInTier * tier.pricePerToken;
          remaining -= toFillInTier;
        }

        // Overflow beyond all tiers uses flat pricePerToken
        if (remaining > 0) {
          totalCost += remaining * launch.pricePerToken;
        }
      } else {
        totalCost = amount * launch.pricePerToken;
      }

      // Apply referral discount
      let finalCost = totalCost;
      let referralCodeId: string | null = null;

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

        const discount = (totalCost * refCode.discountPercent) / 100;
        finalCost = totalCost - discount;
        referralCodeId = refCode.id;

        // Increment referral usage
        await prisma.referralCode.update({
          where: { id: refCode.id },
          data: { usedCount: { increment: 1 } },
        });
      }

      const purchase = await prisma.purchase.create({
        data: {
          launchId: id,
          userId: req.user!.id,
          walletAddress,
          amount: parseInt(amount),
          totalCost: finalCost,
          txSignature,
          referralCodeId,
        },
      });

      res.status(201).json(purchase);
    } catch (error) {
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
      (sum: number, p :any) => sum + p.amount,
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
    const tgeAmount = Math.floor((totalPurchased * vesting.tgePercent) / 100);
    const cliffEndsAt = new Date(
      firstPurchaseTime.getTime() + vesting.cliffDays * 24 * 60 * 60 * 1000,
    );

    const now = new Date();
    let vestedAmount = tgeAmount;
    let claimableAmount = tgeAmount;
    let lockedAmount = totalPurchased - tgeAmount;

    if (now > cliffEndsAt) {
      const vestingStart = new Date(
        firstPurchaseTime.getTime() + vesting.cliffDays * 24 * 60 * 60 * 1000,
      );
      const vestingEnd = new Date(
        vestingStart.getTime() + vesting.vestingDays * 24 * 60 * 60 * 1000,
      );

      if (now >= vestingEnd) {
        vestedAmount = totalPurchased;
        claimableAmount = totalPurchased;
        lockedAmount = 0;
      } else {
        const elapsed = now.getTime() - vestingStart.getTime();
        const totalVestingTime = vesting.vestingDays * 24 * 60 * 60 * 1000;
        const vestingProgress = elapsed / totalVestingTime;
        const releasedAfterCliff = Math.floor(
          (totalPurchased - tgeAmount) * vestingProgress,
        );
        vestedAmount = tgeAmount + releasedAfterCliff;
        claimableAmount = vestedAmount;
        lockedAmount = totalPurchased - vestedAmount;
      }
    }

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
