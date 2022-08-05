// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

interface IInsuranceFund {
    /// @param borrower The address of the borrower (actually is `Vault` address)
    /// @dev In the previous version `Vault` used to "borrow" from IF by calling `IF.borrow()`.
    ///      We have since removed the behavior but kept the variable name "borrower" for
    ///      backward-compatibility
    event BorrowerChanged(address borrower);

    /// @param repaidAmount Repaid amount of the token
    /// @param tokenBalanceAfterRepaid InsuranceFund's token balance after repay
    event Repaid(uint256 repaidAmount, uint256 tokenBalanceAfterRepaid);

    /// @param threshold Threshold amount
    /// @dev We will transfer fee to `SurplusBeneficiary` if `InsuranceFund` free collateral is over threshold
    event ThresholdChanged(uint256 threshold);

    /// @param surplusBeneficiary The address of `SurplusBeneficiary`
    event SurplusBeneficiaryChanged(address surplusBeneficiary);

    /// @param surplus The amount of distribution
    /// @param insuranceFundWalletBalance The usdc balance of `insuranceFund` contract
    /// @param insuranceFundFreeCollateral The free collateral(usdc) of `insuranceFund` contract in vault
    /// @param threshold The threshold amount
    event FeeDistributed(
        uint256 surplus,
        uint256 insuranceFundWalletBalance,
        uint256 insuranceFundFreeCollateral,
        uint256 threshold
    );

    /// @notice If insurance has negative accountValue of vault, will deposit amount to vault
    function repay() external;

    /// @notice If balance of `InsuranceFund` is over `threshold`, transfer diff to `SurplusBeneficiary` contract
    /// @dev Insurance Fund should only distribute revenues surplus earned on the platform.
    ///      In other words, funds directly held in the Insurance Fund contract (`insuranceFundWalletBalance`)
    ///      contributes to `insuranceFundTotalBalance` but not necessarily to `surplus`. Anyone can send funds to
    ///      Insurance Fund and help it reach `threshold` sooner, but once `surplus` exceeds
    ///      the revenues earned on the platform (`insuranceFundFreeCollateral`), sending more funds
    ///      won’t increase `surplus` further
    function distributeFee() external;

    /// @notice Get settlement token address
    /// @return token The address of settlement token
    function getToken() external view returns (address token);

    /// @notice Get borrower(`Vault`) address
    /// @return vault The address of `Vault`
    function getBorrower() external view returns (address vault);

    /// @notice Get insurance threshold
    /// @return threshold The threshold number
    function getThreshold() external view returns (uint256 threshold);

    /// @notice Get SurplusBeneficiary
    /// @return surplusBeneficiary The address of `SurplusBeneficiary`
    function getSurplusBeneficiary() external view returns (address surplusBeneficiary);
}
