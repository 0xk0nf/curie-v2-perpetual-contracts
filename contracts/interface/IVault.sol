// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

interface IVault {
    function balanceOf(address account) external view returns (int256);

    function decimals() external view returns (uint8);

    function getRequiredCollateral(address trader, uint24 ratio) external view returns (int256);
}
