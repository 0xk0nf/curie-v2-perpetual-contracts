// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

library OpenOrder {
    /// @param lastFeeGrowthInsideX128 fees in quote token recorded in Exchange
    ///        because of block-based funding, quote-only and customized fee, all fees are in quote token
    struct Info {
        uint128 liquidity;
        int24 lowerTick;
        int24 upperTick;
        uint256 lastFeeGrowthInsideX128;
        int256 lastTwPremiumGrowthInsideX96;
        int256 lastTwPremiumGrowthBelowX96;
        int256 lastTwPremiumDivBySqrtPriceGrowthInsideX96;
    }
}