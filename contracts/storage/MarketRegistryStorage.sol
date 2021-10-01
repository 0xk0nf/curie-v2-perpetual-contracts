// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { IMarketRegistry } from "../interface/IMarketRegistry.sol";

abstract contract MarketRegistryStorageV1 is IMarketRegistry {
    address internal uniswapV3Factory;
    address internal quoteToken;
    address public override clearingHouse;
    uint8 public override maxOrdersPerMarket;

    // key: baseToken, value: pool
    mapping(address => address) internal _poolMap;

    // key: baseToken, what insurance fund get = exchangeFee * insuranceFundFeeRatio
    mapping(address => uint24) internal _insuranceFundFeeRatioMap;

    // key: baseToken , uniswap fee will be ignored and use the exchangeFeeRatio instead
    mapping(address => uint24) internal _exchangeFeeRatioMap;

    // key: baseToken, _uniswapFeeRatioMap cache only
    mapping(address => uint24) internal _uniswapFeeRatioMap;
}