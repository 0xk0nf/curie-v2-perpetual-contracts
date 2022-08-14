// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

import { AddressUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/AddressUpgradeable.sol";
import { SignedSafeMathUpgradeable } from "@openzeppelin/contracts-upgradeable/math/SignedSafeMathUpgradeable.sol";
import { ReentrancyGuardUpgradeable } from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {
    SafeERC20Upgradeable,
    IERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/SafeERC20Upgradeable.sol";
import { ISurplusBeneficiary } from "@perp/voting-escrow/contracts/interface/ISurplusBeneficiary.sol";
import { PerpMath } from "./lib/PerpMath.sol";
import { PerpSafeCast } from "./lib/PerpSafeCast.sol";
import { InsuranceFundStorageV2 } from "./storage/InsuranceFundStorage.sol";
import { OwnerPausable } from "./base/OwnerPausable.sol";
import { IInsuranceFund } from "./interface/IInsuranceFund.sol";
import { IVault } from "./interface/IVault.sol";

// never inherit any new stateful contract. never change the orders of parent stateful contracts
contract InsuranceFund is IInsuranceFund, ReentrancyGuardUpgradeable, OwnerPausable, InsuranceFundStorageV2 {
    using AddressUpgradeable for address;
    using SignedSafeMathUpgradeable for int256;
    using PerpMath for int256;
    using PerpSafeCast for int256;
    using PerpSafeCast for uint256;

    //
    // MODIFIER
    //

    function initialize(address tokenArg) external initializer {
        // token address is not contract
        require(tokenArg.isContract(), "IF_TNC");

        __ReentrancyGuard_init();
        __OwnerPausable_init();

        _token = tokenArg;
    }

    function setBorrower(address borrowerArg) external onlyOwner {
        // borrower is not a contract
        require(borrowerArg.isContract(), "IF_BNC");
        _borrower = borrowerArg;
        emit BorrowerChanged(borrowerArg);
    }

    function setThreshold(uint256 threshold) external onlyOwner {
        _threshold = threshold;
        emit ThresholdChanged(threshold);
    }

    function setSurplusBeneficiary(address surplusBeneficiary) external onlyOwner {
        // IF_SNC: surplusBeneficiary is not a contract
        require(surplusBeneficiary.isContract(), "IF_SNC");

        // IF_TNM: token is not match
        require(ISurplusBeneficiary(surplusBeneficiary).getToken() == _token, "IF_TNM");

        _surplusBeneficiary = surplusBeneficiary;
        emit SurplusBeneficiaryChanged(surplusBeneficiary);
    }

    /// @inheritdoc IInsuranceFund
    function repay() external override nonReentrant whenNotPaused {
        address vault = _borrower;
        address token = _token;

        int256 accountValue = IVault(vault).getAccountValue(address(this));

        // IF_RWN: repay when negative
        require(accountValue < 0, "IF_RWN");

        uint256 tokenBalance = IERC20Upgradeable(token).balanceOf(address(this));
        uint256 repaidAmount = tokenBalance >= accountValue.abs() ? accountValue.abs() : tokenBalance;

        IERC20Upgradeable(token).approve(vault, repaidAmount);
        IVault(vault).deposit(token, repaidAmount);

        uint256 tokenBalanceAfterRepaid = IERC20Upgradeable(token).balanceOf(address(this));

        emit Repaid(repaidAmount, tokenBalanceAfterRepaid);
    }

    //
    // EXTERNAL VIEW
    //

    /// @inheritdoc IInsuranceFund
    function distributeFee() external override nonReentrant whenNotPaused {
        address vault = _borrower;
        address token = _token;
        address surplusBeneficiary = _surplusBeneficiary;
        int256 threshold = _threshold.toInt256();

        // IF_SNS: surplusBeneficiary not yet set
        require(surplusBeneficiary != address(0), "IF_SNS");

        // IF_TEZ: threshold is equal to zero
        require(threshold > 0, "IF_TEZ");

        // This assumes `token` is always Insurance Fund's sole collateral.
        // Normally it won't happen, but in theory other users could send any collateral to
        // Insurance Fund through `depositFor()` and they will be ignored.
        int256 insuranceFundFreeCollateral = IVault(vault).getFreeCollateralByToken(address(this), token).toInt256();

        int256 insuranceFundCapacity = getInsuranceFundCapacity();

        int256 overThreshold = PerpMath.max(insuranceFundCapacity.sub(threshold), 0);
        uint256 surplus = PerpMath.min(overThreshold, insuranceFundFreeCollateral).toUint256();

        // IF_NSP: no surplus
        require(surplus > 0, "IF_NSP");

        // this should always work since surplus <= insuranceFundFreeCollateral
        IVault(vault).withdraw(token, surplus);
        // this should always work since IF would have at least `surplus` USDC by now
        SafeERC20Upgradeable.safeTransfer(IERC20Upgradeable(token), surplusBeneficiary, surplus);

        ISurplusBeneficiary(surplusBeneficiary).dispatch();

        emit FeeDistributed(
            surplus,
            insuranceFundCapacity.toUint256(),
            insuranceFundFreeCollateral.toUint256(),
            threshold.toUint256()
        );
    }

    /// @inheritdoc IInsuranceFund
    function getToken() external view override returns (address) {
        return _token;
    }

    /// @inheritdoc IInsuranceFund
    function getBorrower() external view override returns (address) {
        return _borrower;
    }

    /// @inheritdoc IInsuranceFund
    function getThreshold() external view override returns (uint256) {
        return _threshold;
    }

    /// @inheritdoc IInsuranceFund
    function getSurplusBeneficiary() external view override returns (address) {
        return _surplusBeneficiary;
    }

    //
    // PUBLIC VIEW
    //

    /// @inheritdoc IInsuranceFund
    function getInsuranceFundCapacity() public view override returns (int256) {
        address vault = _borrower;
        address token = _token;

        int256 insuranceFundAccountValueX10_S = IVault(vault).getAccountValue(address(this));
        int256 insuranceFundWalletBalanceX10_S = IERC20Upgradeable(token).balanceOf(address(this)).toInt256();
        int256 insuranceFundCapacityX10_S = insuranceFundAccountValueX10_S.add(insuranceFundWalletBalanceX10_S);

        return insuranceFundCapacityX10_S;
    }
}
