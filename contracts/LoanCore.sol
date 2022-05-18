// SPDX-License-Identifier: MIT

pragma solidity ^0.8.11;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC721/IERC721Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/IERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/CountersUpgradeable.sol";

import "./interfaces/ICallDelegator.sol";
import "./interfaces/IPromissoryNote.sol";
import "./interfaces/IAssetVault.sol";
import "./interfaces/IFeeController.sol";
import "./interfaces/ILoanCore.sol";

import "./FullInterestAmountCalc.sol";
import "./PromissoryNote.sol";
import "./vault/OwnableERC721.sol";
import {
    LC_ZeroAddress,
    LC_CollateralInUse,
    LC_StartInvalidState,
    LC_NotExpired,
    LC_BalanceGTZero,
    LC_NonceUsed
} from "./errors/Lending.sol";

/**
 * @title LoanCore
 * @author Non-Fungible Technologies, Inc.
 *
 * The LoanCore lending contract is the heart of the Arcade.xyz lending protocol.
 * It stores and maintains loan state, enforces loan lifecycle invariants, takes
 * escrow of assets during an active loans, governs the release of collateral on
 * repayment or default, and tracks signature nonces for loan consent.
 *
 * Also contains logic for approving Asset Vault calls using the
 * ICallDelegator interface.
 */
contract LoanCore is
    ILoanCore,
    Initializable,
    FullInterestAmountCalc,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ICallDelegator,
    UUPSUpgradeable
{
    using CountersUpgradeable for CountersUpgradeable.Counter;
    using SafeERC20Upgradeable for IERC20Upgradeable;

    // ============================================ STATE ==============================================

    // =================== Constants =====================

    bytes32 public constant ORIGINATOR_ROLE = keccak256("ORIGINATOR_ROLE");
    bytes32 public constant REPAYER_ROLE = keccak256("REPAYER_ROLE");
    bytes32 public constant FEE_CLAIMER_ROLE = keccak256("FEE_CLAIMER_ROLE");

    // 10k bps per whole
    uint256 private constant BPS_DENOMINATOR = 10_000;
    uint256 private constant PERCENT_MISSED_FOR_LENDER_CLAIM = 4000;

    // =============== Contract References ================

    IPromissoryNote public override borrowerNote;
    IPromissoryNote public override lenderNote;
    IFeeController public override feeController;

    // =================== Loan State =====================

    CountersUpgradeable.Counter private loanIdTracker;
    mapping(uint256 => LoanLibrary.LoanData) private loans;
    // key is hash of (collateralAddress, collateralId)
    mapping(bytes32 => bool) private collateralInUse;
    mapping(address => mapping(uint160 => bool)) public usedNonces;

    // ========================================== CONSTRUCTOR ===========================================

    /**
     * @notice Runs the initializer function in an upgradeable contract.
     *
     * @dev Add Unsafe-allow comment to notify upgrades plugin to accept the constructor.
     */
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() initializer {}

    // ========================================== INITIALIZER ===========================================

    /**
     * @notice Initializes tehe loan core contract, by initializing parent
     *         contracts, setting up roles, and setting up contract references.
     *
     * @param _feeController      The address of the contract governing protocol fees.
     */
    function initialize(IFeeController _feeController, IPromissoryNote _borrowerNote, IPromissoryNote _lenderNote) public initializer {
        if (address(_feeController) == address(0)) revert LC_ZeroAddress();
        if (address(_borrowerNote) == address(0)) revert LC_ZeroAddress();
        if (address(_lenderNote) == address(0)) revert LC_ZeroAddress();

        // only those with FEE_CLAIMER_ROLE can update or grant FEE_CLAIMER_ROLE
        __AccessControl_init();
        __UUPSUpgradeable_init_unchained();

        _setupRole(DEFAULT_ADMIN_ROLE, _msgSender());
        _setupRole(FEE_CLAIMER_ROLE, _msgSender());
        _setRoleAdmin(FEE_CLAIMER_ROLE, FEE_CLAIMER_ROLE);

        feeController = _feeController;

        /// @dev Although using references for both promissory notes, these
        ///      must be fresh versions and cannot be re-used across multiple
        ///      loanCore instances, to ensure loanId <> tokenID parity
        borrowerNote = _borrowerNote;
        lenderNote = _lenderNote;

        // Avoid having loanId = 0
        loanIdTracker.increment();
    }

    // ===================================== UPGRADE AUTHORIZATION ======================================

    /**
     * @notice Authorization function to define whether a contract upgrade should be allowed.
     *
     * @param newImplementation     The address of the upgraded verion of this contract.
     */
    function _authorizeUpgrade(address newImplementation) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    // ====================================== LIFECYCLE OPERATIONS ======================================

    /**
     * @notice Start a loan, matching a set of terms, with a given
     *         lender and borrower. Collects collateral and distributes
     *         principal, along with collecting an origination fee for the
     *         protocol. Can only be called by OriginationController.
     *
     * @param lender                The lender for the loan.
     * @param borrower              The borrower for the loan.
     * @param terms                 The terms of the loan.
     *
     * @return loanId               The ID of the newly created loan.
     */
    function startLoan(
        address lender,
        address borrower,
        LoanLibrary.LoanTerms calldata terms
    )
        external
        override
        whenNotPaused
        onlyRole(ORIGINATOR_ROLE)
        returns (uint256 loanId)
    {
        // check collateral is not already used in a loan.
        bytes32 collateralKey = keccak256(abi.encode(terms.collateralAddress, terms.collateralId));
        if (collateralInUse[collateralKey])
            revert LC_CollateralInUse(terms.collateralAddress, terms.collateralId);

        // get current loanId and increment for next function call
        loanId = loanIdTracker.current();
        loanIdTracker.increment();

        // Initiate loan state
        loans[loanId] = LoanLibrary.LoanData({
            terms: terms,
            state: LoanLibrary.LoanState.Active,
            startDate: uint160(block.timestamp),
            balance: terms.principal,
            balancePaid: 0,
            lateFeesAccrued: 0,
            numInstallmentsPaid: 0
        });

        collateralInUse[collateralKey] = true;

        // Distribute notes and principal
        borrowerNote.mint(borrower, loanId);
        lenderNote.mint(lender, loanId);

        IERC721Upgradeable(terms.collateralAddress).transferFrom(_msgSender(), address(this), terms.collateralId);

        IERC20Upgradeable(terms.payableCurrency).safeTransferFrom(
            _msgSender(),
            address(this),
            terms.principal
        );

        IERC20Upgradeable(terms.payableCurrency).safeTransfer(
            borrower,
            _getPrincipalLessFees(terms.principal)
        );

        emit LoanStarted(loanId, lender, borrower);
    }

    /**
     * @notice Repay the given loan. Can only be called by RepaymentController,
     *         which verifies repayment conditions. This method will calculate
     *         the total interest due, collect it from the borrower, and redistribute
     *         principal + interest to he lender, and collateral to the borrower.
     *         All promissory notes will be burned and the loan will be marked as complete.
     *
     * @param loanId                The ID of the loan to repay.
     */
    function repay(uint256 loanId) external override onlyRole(REPAYER_ROLE) {
        LoanLibrary.LoanData memory data = loans[loanId];
        // ensure valid initial loan state when starting loan
        if (data.state != LoanLibrary.LoanState.Active) revert LC_StartInvalidState(data.state);

        uint256 returnAmount = getFullInterestAmount(data.terms.principal, data.terms.interestRate);
        // ensure balance to be paid is greater than zero
        if (returnAmount == 0) revert LC_BalanceGTZero(returnAmount);

        // transfer from msg.sender to this contract
        IERC20Upgradeable(data.terms.payableCurrency).safeTransferFrom(_msgSender(), address(this), returnAmount);

        // get promissory notes from two parties involved
        address lender = lenderNote.ownerOf(loanId);
        address borrower = borrowerNote.ownerOf(loanId);

        // state changes and cleanup
        // NOTE: these must be performed before assets are released to prevent reentrance
        loans[loanId].state = LoanLibrary.LoanState.Repaid;
        collateralInUse[keccak256(abi.encode(data.terms.collateralAddress, data.terms.collateralId))] = false;

        lenderNote.burn(loanId);
        borrowerNote.burn(loanId);

        // asset and collateral redistribution
        IERC20Upgradeable(data.terms.payableCurrency).safeTransfer(lender, returnAmount);
        IERC721Upgradeable(data.terms.collateralAddress).transferFrom(address(this), borrower, data.terms.collateralId);

        emit LoanRepaid(loanId);
    }

    /**
     * @notice Claim collateral on a given loan. Can only be called by RepaymentController,
     *         which verifies claim conditions. This method validate that the loan's due
     *         date has passed, and then distribute collateral to the lender. All promissory
     *         notes will be burned and the loan will be marked as complete.
     *
     * @param loanId                              The ID of the loan to claim.
     * @param currentInstallmentPeriod            The current installment period if
     *                                            installment loan type, else 0.
     */
    function claim(uint256 loanId, uint256 currentInstallmentPeriod) external override whenNotPaused onlyRole(REPAYER_ROLE) {
        LoanLibrary.LoanData memory data = loans[loanId];
        // ensure valid initial loan state when starting loan
        if (data.state != LoanLibrary.LoanState.Active) revert LC_StartInvalidState(data.state);
        // for legacy loans (currentInstallmentPeriod == 0) ensure lender is claiming
        // after the loan has ended and if so, block.timstamp must be greater than the dueDate.
        // for installment loan types (currentInstallmentPeriod > 0), check if the loan
        // is in default, if not, revert.
        if (data.terms.numInstallments == 0) {
            uint256 dueDate = data.startDate + data.terms.durationSecs;
            if (dueDate > block.timestamp) revert LC_NotExpired(dueDate);
        } else {
            _verifyDefaultedLoan(
                data.terms.numInstallments,
                data.numInstallmentsPaid,
                currentInstallmentPeriod,
                data.startDate,
                data.terms.durationSecs
            );
        }

        address lender = lenderNote.ownerOf(loanId);

        // NOTE: these must be performed before assets are released to prevent reentrance
        loans[loanId].state = LoanLibrary.LoanState.Defaulted;
        collateralInUse[keccak256(abi.encode(data.terms.collateralAddress, data.terms.collateralId))] = false;

        lenderNote.burn(loanId);
        borrowerNote.burn(loanId);

        // collateral redistribution
        IERC721Upgradeable(data.terms.collateralAddress).transferFrom(address(this), lender, data.terms.collateralId);

        emit LoanClaimed(loanId);
    }

    // ===================================== INSTALLMENT OPERATIONS =====================================

    /**
     * @notice Called from RepaymentController when paying back an installment loan.
     *         New loan state parameters are calculated in the Repayment Controller.
     *         Based on if the _paymentToPrincipal is greater than the current balance,
     *         the loan state is updated. (0 = minimum payment sent, > 0 pay down principal).
     *         The paymentTotal (_paymentToPrincipal + _paymentToLateFees) is always transferred to the lender.
     *
     * @param _loanId                       The ID of the loan..
     * @param _currentMissedPayments        Number of payments missed since the last isntallment payment.
     * @param _paymentToPrincipal           Amount sent in addition to minimum amount due, used to pay down principal.
     * @param _paymentToInterest            Amount due in interest.
     * @param _paymentToLateFees            Amount due in only late fees.
     */
    function repayPart(
        uint256 _loanId,
        uint256 _currentMissedPayments,
        uint256 _paymentToPrincipal,
        uint256 _paymentToInterest,
        uint256 _paymentToLateFees
    ) external override onlyRole(REPAYER_ROLE) {
        LoanLibrary.LoanData storage data = loans[_loanId];
        // ensure valid initial loan state when repaying loan
        if (data.state != LoanLibrary.LoanState.Active) revert LC_StartInvalidState(data.state);

        // calculate total sent by borrower and transferFrom repayment controller to this address
        uint256 paymentTotal = _paymentToPrincipal + _paymentToLateFees + _paymentToInterest;
        IERC20Upgradeable(data.terms.payableCurrency).safeTransferFrom(_msgSender(), address(this), paymentTotal);

        // get the lender and borrower
        address lender = lenderNote.ownerOf(_loanId);
        address borrower = borrowerNote.ownerOf(_loanId);

        uint256 _balanceToPay = _paymentToPrincipal;
        if (_balanceToPay >= data.balance) {
            _balanceToPay = data.balance;

            // mark loan as closed
            data.state = LoanLibrary.LoanState.Repaid;
            collateralInUse[keccak256(abi.encode(data.terms.collateralAddress, data.terms.collateralId))] = false;
            lenderNote.burn(_loanId);
            borrowerNote.burn(_loanId);
        }

        // Unlike paymentTotal, cannot go over maximum amount owed
        uint256 boundedPaymentTotal = _balanceToPay + _paymentToLateFees + _paymentToInterest;

        // update loan state
        data.lateFeesAccrued += _paymentToLateFees;
        data.numInstallmentsPaid += uint24(_currentMissedPayments) + 1;
        data.balance -= _balanceToPay;
        data.balancePaid += boundedPaymentTotal;

        // Send payment to lender.
        IERC20Upgradeable(data.terms.payableCurrency).safeTransfer(lender, boundedPaymentTotal);

        // If repaid, send collateral to borrower
        if (data.state == LoanLibrary.LoanState.Repaid) {
            IERC721Upgradeable(data.terms.collateralAddress).transferFrom(address(this), borrower, data.terms.collateralId);

            if (_paymentToPrincipal > _balanceToPay) {
                // Borrower overpaid, so send refund
                IERC20Upgradeable(data.terms.payableCurrency).safeTransfer(borrower, _paymentToPrincipal - _balanceToPay);
            }

            emit LoanRepaid(_loanId);
        } else {
            // minimum repayment events will emit 0 and unchanged principal
            emit InstallmentPaymentReceived(_loanId, _paymentToPrincipal, data.balance);
        }
    }

    // ======================================== NONCE MANAGEMENT ========================================

    /**
     * @notice Mark a nonce as used in the context of starting a loan. Reverts if
     *         nonce has already been used. Can only be called by Origination Controller.
     *
     * @param user                  The user for whom to consume a nonce.
     * @param nonce                 The nonce to consume.
     */
    function consumeNonce(address user, uint160 nonce) external override whenNotPaused onlyRole(ORIGINATOR_ROLE) {
        _useNonce(user, nonce);
    }

    /**
     * @notice Mark a nonce as used in order to invalidate signatures with the nonce.
     *         Does not allow specifying the user, and automatically consumes the nonce
     *         of the caller.
     *
     * @param nonce                 The nonce to consume.
     */
    function cancelNonce(uint160 nonce) external override {
        address user = _msgSender();
        _useNonce(user, nonce);
    }

    // ========================================= VIEW FUNCTIONS =========================================

    /**
     * @notice Returns the LoanData struct for the specified loan ID.
     *
     * @param loanId                The ID of the given loan.
     *
     * @return loanData             The struct containing loan state and terms.
     */
    function getLoan(uint256 loanId) external view override returns (LoanLibrary.LoanData memory loanData) {
        return loans[loanId];
    }

    /**
     * @notice Reports if the caller is allowed to call functions on the given vault.
     *         Determined by if they are the borrower for the loan, defined by ownership
     *         of the relevant BorrowerNote.
     *
     * @dev Implemented as part of the ICallDelegator interface.
     *
     * @param caller                The user that wants to call a function.
     * @param vault                 The vault that the caller wants to call a function on.
     *
     * @return allowed              True if the caller is allowed to call on the vault.
     */
    function canCallOn(address caller, address vault) external view override returns (bool) {
        // if the collateral is not currently being used in a loan, disallow
        if (!collateralInUse[keccak256(abi.encode(OwnableERC721(vault).ownershipToken(), uint256(uint160(vault))))]) {
            return false;
        }
        for (uint256 i = 0; i < borrowerNote.balanceOf(caller); i++) {
            uint256 loanId = borrowerNote.tokenOfOwnerByIndex(caller, i);

            // if the borrower is currently borrowing against this vault,
            // return true
            if (loans[loanId].terms.collateralId == uint256(uint160(vault))) {
                return true;
            }
        }
        return false;
    }

    /**
     * @notice Reports whether the given nonce has been previously used by a user. Returning
     *         false does not mean that the nonce will not clash with another potential off-chain
     *         signature that is stored somewhere.
     *
     * @param user                  The user to check the nonce for.
     * @param nonce                 The nonce to check.
     *
     * @return used                 Whether the nonce has been used.
     */
    function isNonceUsed(address user, uint160 nonce) external view override returns (bool) {
        return usedNonces[user][nonce];
    }

    // ======================================== ADMIN FUNCTIONS =========================================

    /**
     * @notice Sets the fee controller to a new address. It must implement the
     *         IFeeController interface. Can only be called by the contract owner.
     *
     * @param _newController        The new fee controller contract.
     */
    function setFeeController(IFeeController _newController) external onlyRole(FEE_CLAIMER_ROLE) {
        if(address(_newController) == address(0)) revert LC_ZeroAddress();

        feeController = _newController;

        emit SetFeeController(address(feeController));
    }

    /**
     * @notice Claim the protocol fees for the given token. Any token used as principal
     *         for a loan will have accumulated fees. Must be called by contract owner.
     *
     * @param token                 The contract address of the token to claim fees for.
     */
    function claimFees(IERC20Upgradeable token) external onlyRole(FEE_CLAIMER_ROLE) {
        // any token balances remaining on this contract are fees owned by the protocol
        uint256 amount = token.balanceOf(address(this));
        token.safeTransfer(_msgSender(), amount);
        emit FeesClaimed(address(token), _msgSender(), amount);
    }

    /**
     * @notice Pauses the contract, preventing loan lifecyle operations.
     *         Should only be used in case of emergency. Can only be called
     *         by contract owner.
     */
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /**
     * @notice Unpauses the contract, enabling loan lifecyle operations.
     *         Can be used after pausing due to emergency or during contract
     *         upgrade. Can only be called by contract owner.
     */
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ============================================= HELPERS ============================================

    /**
     * @dev Takes a principal value and returns the amount that will be distributed
     *      to the borrower after protocol fees.
     *
     * @param principal             The principal amount.
     *
     * @return principalLessFees    The amount after fees.
     */
    function _getPrincipalLessFees(uint256 principal) internal view returns (uint256) {
        return principal - principal * feeController.getOriginationFee() / BPS_DENOMINATOR;
    }

    /**
     * @dev Consume a nonce, by marking it as used for that user. Reverts if the nonce
     *      has already been used.
     *
     * @param user                  The user for whom to consume a nonce.
     * @param nonce                 The nonce to consume.
     */
    function _useNonce(address user, uint160 nonce) internal {
        if (usedNonces[user][nonce]) revert LC_NonceUsed(user, nonce);
        // set nonce to used
        usedNonces[user][nonce] = true;

        emit NonceUsed(user, nonce);
    }

    /**
     * @notice Check if the loan is available for collateral claim via default.
     *         This function passes when the last payment made by the borrower
     *         was over 40% of the total number of installment periods in the loan terms.
     *
     * @dev Missed payments checked are consecutive due how the numInstallmentsPaid
     *      value in LoanData is being updated to the current installment period
     *      everytime a repayment at any time is made for an installment loan.
     *      (numInstallmentsPaid += _currentMissedPayments + 1)
     *
     * @param numInstallments                  Total number of installments in loan.
     * @param numInstallmentsPaid              Installment period of the last installment payment.
     * @param currentInstallmentPeriod         Current installment period call made in.
     * @param startDate                        Timestamp of the start of the loan.
     * @param durationSecs                     Duration of the loan in seconds.
     */
    function _verifyDefaultedLoan(uint256 numInstallments, uint256 numInstallmentsPaid, uint256 currentInstallmentPeriod, uint256 startDate, uint256 durationSecs) internal view {
        // get installments missed necessary for loan default (*1000)
        uint256 installmentsMissedForDefault = ((numInstallments * PERCENT_MISSED_FOR_LENDER_CLAIM) * 1000) / BPS_DENOMINATOR;
        // check if the number of missed payments is greater than
        // 40% the total number of installment periods AND check the current time into loan
        // ((block.timestamp - startDate) * 1000) is greater than (installmentsMissedForDefault * secondsPerInstallment)
        require(numInstallmentsPaid < installmentsMissedForDefault, "Default");
        // get current time into loan in seconds (*1000)
        uint256 _currentTimeInLoan = (block.timestamp - startDate) * 1000;
        // get time needed to default using installments missed, this value already has the multiplier attached
        uint256 _timeNeededForDefault = (installmentsMissedForDefault * durationSecs) / numInstallments;
        require(_currentTimeInLoan > _timeNeededForDefault, "Default");
    }
}
