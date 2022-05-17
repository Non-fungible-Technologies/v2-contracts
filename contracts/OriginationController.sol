// SPDX-License-Identifier: MIT

pragma solidity ^0.8.11;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/draft-EIP712Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/utils/SafeERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/cryptography/ECDSAUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/security/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";

import "./interfaces/IOriginationController.sol";
import "./interfaces/ILoanCore.sol";
import "./interfaces/IERC721Permit.sol";
import "./interfaces/IAssetVault.sol";
import "./interfaces/IVaultFactory.sol";
import "./interfaces/ISignatureVerifier.sol";

import "./verifiers/ItemsVerifier.sol";
import {
    OC_ZeroAddress,
    OC_InvalidVerifier,
    OC_BatchLengthMismatch,
    OC_PredicateFailed,
    OC_SelfApprove,
    OC_ApprovedOwnLoan,
    OC_InvalidSignature,
    OC_CallerNotParticipant,
    OC_PrincipalTooLow
} from "./errors/Lending.sol";

/**
 * @title OriginationController
 * @author Non-Fungible Technologies, Inc.
 *
 * The Origination Controller is the entry point for all new loans
 * in the Arcade.xyz lending protocol. This contract should have the
 * exclusive responsibility to create new loans in LoanCore. All
 * permissioning, signature verification, and collateral verification
 * takes place in this contract. To originate a loan, the controller
 * also takes custody of both the collateral and loan principal.
 */
contract OriginationController is
    Initializable,
    ContextUpgradeable,
    IOriginationController,
    EIP712Upgradeable,
    ReentrancyGuardUpgradeable,
    OwnableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20Upgradeable for IERC20Upgradeable;

    // ============================================ STATE ==============================================

    // =================== Constants =====================

    /// @notice EIP712 type hash for bundle-based signatures.
    bytes32 private constant _TOKEN_ID_TYPEHASH =
        keccak256(
            // solhint-disable-next-line max-line-length
            "LoanTerms(uint32 durationSecs,uint24 numInstallments,uint200 interestRate,uint256 principal,address collateralAddress,uint256 collateralId,address payableCurrency,uint160 nonce)"
        );

    /// @notice EIP712 type hash for item-based signatures.
    bytes32 private constant _ITEMS_TYPEHASH =
        keccak256(
            // solhint-disable max-line-length
            "LoanTermsWithItems(uint32 durationSecs,uint24 numInstallments,uint200 interestRate,uint256 principal,address collateralAddress,bytes32 itemsHash,address payableCurrency,uint160 nonce)"
        );

    // =============== Contract References ===============

    address public loanCore;

    // ================= Approval State ==================

    /// @notice Mapping from owner to operator approvals
    mapping(address => mapping(address => bool)) private _signerApprovals;
    /// @notice Mapping from address to whether that verifier contract has been whitelisted
    mapping(address => bool) public allowedVerifiers;

    // ========================================== CONSTRUCTOR ===========================================

    /**
     * @notice Runs the initializer function in an upgradeable contract.
     *
     *  @dev Add Unsafe-allow comment to notify upgrades plugin to accept the constructor.
     */
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() initializer {}

    // ========================================== INITIALIZER ===========================================

    /**
     * @notice Creates a new origination controller contract, also initializing
     * the parent signature verifier.
     *
     * @dev For this controller to work, it needs to be granted the ORIGINATOR_ROLE
     *      in loan core after deployment.
     *
     * @param _loanCore                     The address of the loan core logic of the protocol.
     */

    function initialize(address _loanCore) public initializer {
        __EIP712_init("OriginationController", "2");
        __Ownable_init_unchained();
        __UUPSUpgradeable_init_unchained();
        if (_loanCore == address(0)) revert OC_ZeroAddress();

        loanCore = _loanCore;
    }

    // ======================================= UPGRADE AUTHORIZATION ========================================

    /**
     * @notice Authorization function to define who should be allowed to upgrade the contract
     *
     * @param newImplementation           The address of the upgraded verion of this contract
     */

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ==================================== ORIGINATION OPERATIONS ======================================

    /**
     * @notice Initializes a loan with Loan Core.
     * @notice Works with either wrapped bundles with an ID, or specific ERC721 unwrapped NFTs.
     *         In that case, collateralAddress should be the token contract.
     *
     * @dev The caller must be a borrower or lender, or approved by a borrower or lender.
     * @dev The external signer must be a borrower or lender, or approved by a borrower or lender.
     * @dev The external signer must come from the opposite side of the loan as the caller.
     *
     * @param loanTerms                     The terms agreed by the lender and borrower.
     * @param borrower                      Address of the borrower.
     * @param lender                        Address of the lender.
     * @param sig                           The loan terms signature, with v, r, s fields, and a nonce.
     * @param nonce                         The signature nonce.
     *
     * @return loanId                       The unique ID of the new loan.
     */
    function initializeLoan(
        LoanLibrary.LoanTerms calldata loanTerms,
        address borrower,
        address lender,
        Signature calldata sig,
        uint160 nonce
    ) public override returns (uint256 loanId) {
        (bytes32 sighash, address externalSigner) = recoverTokenSignature(loanTerms, sig, nonce);

        _validateCounterparties(borrower, lender, msg.sender, externalSigner, sig, sighash);

        // principal must be greater than or equal to 1000 wei
        if (loanTerms.principal <= 9999) revert OC_PrincipalTooLow(loanTerms.principal);

        ILoanCore(loanCore).consumeNonce(externalSigner, nonce);
        loanId = _initialize(loanTerms, borrower, lender);
    }

    /**
     * @notice Initializes a loan with Loan Core.
     * @notice Compared to initializeLoan, this verifies the specific items in a bundle.
     * @notice Only works with bundles implementing the IVaultFactory interface.
     *
     * @dev The caller must be a borrower or lender, or approved by a borrower or lender.
     * @dev The external signer must be a borrower or lender, or approved by a borrower or lender.
     * @dev The external signer must come from the opposite side of the loan as the caller.
     *
     * @param loanTerms                     The terms agreed by the lender and borrower.
     * @param borrower                      Address of the borrower.
     * @param lender                        Address of the lender.
     * @param sig                           The loan terms signature, with v, r, s fields, and a nonce.
     * @param nonce                         The signature nonce.
     * @param itemPredicates                The predicate rules for the items in the bundle.
     *
     * @return loanId                       The unique ID of the new loan.
     */
    function initializeLoanWithItems(
        LoanLibrary.LoanTerms calldata loanTerms,
        address borrower,
        address lender,
        Signature calldata sig,
        uint160 nonce,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) public override returns (uint256 loanId) {
        address vault = IVaultFactory(loanTerms.collateralAddress).instanceAt(loanTerms.collateralId);
        (bytes32 sighash, address externalSigner) = recoverItemsSignature(
            loanTerms,
            sig,
            nonce,
            keccak256(abi.encode(itemPredicates))
        );

        _validateCounterparties(borrower, lender, msg.sender, externalSigner, sig, sighash);

        for (uint256 i = 0; i < itemPredicates.length; i++) {
            // Verify items are held in the wrapper
            address verifier = itemPredicates[i].verifier;
            if (!isAllowedVerifier(verifier)) revert OC_InvalidVerifier(verifier);

            if (!IArcadeSignatureVerifier(verifier).verifyPredicates(itemPredicates[i].data, vault)) {
                revert OC_PredicateFailed(verifier, itemPredicates[i].data, vault);
            }
        }

        ILoanCore(loanCore).consumeNonce(externalSigner, nonce);
        loanId = _initialize(loanTerms, borrower, lender);
    }

    /**
     * @notice Initializes a loan with Loan Core, with a permit signature instead of pre-approved collateral.
     *
     * @dev The caller must be a borrower or lender, or approved by a borrower or lender.
     * @dev The external signer must be a borrower or lender, or approved by a borrower or lender.
     * @dev The external signer must come from the opposite side of the loan as the caller.
     *
     * @param loanTerms                     The terms agreed by the lender and borrower.
     * @param borrower                      Address of the borrower.
     * @param lender                        Address of the lender.
     * @param sig                           The loan terms signature, with v, r, s fields.
     * @param nonce                         The signature nonce for the loan terms signature.
     * @param collateralSig                 The collateral permit signature, with v, r, s fields.
     * @param permitDeadline                The last timestamp for which the signature is valid.
     *
     * @return loanId                       The unique ID of the new loan.
     */
    function initializeLoanWithCollateralPermit(
        LoanLibrary.LoanTerms calldata loanTerms,
        address borrower,
        address lender,
        Signature calldata sig,
        uint160 nonce,
        Signature calldata collateralSig,
        uint256 permitDeadline
    ) external override returns (uint256 loanId) {
        IERC721Permit(loanTerms.collateralAddress).permit(
            borrower,
            address(this),
            loanTerms.collateralId,
            permitDeadline,
            collateralSig.v,
            collateralSig.r,
            collateralSig.s
        );
        loanId = initializeLoan(loanTerms, borrower, lender, sig, nonce);
    }

    /**
     * @notice Initializes a loan with Loan Core, with a permit signature instead of pre-approved collateral.
     * @notice Compared to initializeLoanWithCollateralPermit, this verifies the specific items in a bundle.
     *
     * @dev The caller must be a borrower or lender, or approved by a borrower or lender.
     * @dev The external signer must be a borrower or lender, or approved by a borrower or lender.
     * @dev The external signer must come from the opposite side of the loan as the caller.
     *
     * @param loanTerms                     The terms agreed by the lender and borrower.
     * @param borrower                      Address of the borrower.
     * @param lender                        Address of the lender.
     * @param sig                           The loan terms signature, with v, r, s fields.
     * @param nonce                         The signature nonce for the loan terms signature.
     * @param collateralSig                 The collateral permit signature, with v, r, s fields.
     * @param permitDeadline                The last timestamp for which the signature is valid.
     * @param itemPredicates                The predicate rules for the items in the bundle.
     *
     * @return loanId                       The unique ID of the new loan.
     */
    function initializeLoanWithCollateralPermitAndItems(
        LoanLibrary.LoanTerms calldata loanTerms,
        address borrower,
        address lender,
        Signature calldata sig,
        uint160 nonce,
        Signature calldata collateralSig,
        uint256 permitDeadline,
        LoanLibrary.Predicate[] calldata itemPredicates
    ) external override returns (uint256 loanId) {
        IERC721Permit(loanTerms.collateralAddress).permit(
            borrower,
            address(this),
            loanTerms.collateralId,
            permitDeadline,
            collateralSig.v,
            collateralSig.r,
            collateralSig.s
        );

        loanId = initializeLoanWithItems(loanTerms, borrower, lender, sig, nonce, itemPredicates);
    }

    // ==================================== PERMISSION MANAGEMENT =======================================

    /**
     * @notice Approve a third party to sign or initialize loans on a counterparties' behalf.
     * @notice Useful to multisig counterparties (who cannot sign themselves) or third-party integrations.
     *
     * @param signer                        The party to set approval for.
     * @param approved                      Whether the party should be approved.
     */
    function approve(address signer, bool approved) public override {
        if (signer == msg.sender) revert OC_SelfApprove(msg.sender);

        _signerApprovals[msg.sender][signer] = approved;

        emit Approval(msg.sender, signer, approved);
    }

    /**
     * @notice Reports whether a party is approved to act on a counterparties' behalf.
     *
     * @param owner                         The grantor of permission.
     * @param signer                        The grantee of permission.
     *
     * @return isApproved                   Whether the grantee has been approved by the grantor.
     */
    function isApproved(address owner, address signer) public view virtual override returns (bool) {
        return _signerApprovals[owner][signer];
    }

    /**
     * @notice Reports whether the signer matches the target or is approved by the target.
     *
     * @param target                        The grantor of permission - should be a smart contract.
     * @param sig                           A struct containing the signature data (for checking EIP-1271).
     * @param sighash                   The hash of the signature payload (used for EIP-1271 check).
     *
     * @return isApprovedForContract        Whether the signer is either the grantor themselves, or approved.
     */
    function isApprovedForContract(
        address target,
        Signature calldata sig,
        bytes32 sighash
    ) public view override returns (bool) {
        bytes memory signature = new bytes(65);

        // Construct byte array directly in assembly for efficiency
        uint8 v = sig.v;
        bytes32 r = sig.r;
        bytes32 s = sig.s;

        assembly {
            mstore(add(signature, 32), r)
            mstore(add(signature, 64), s)
            mstore(add(signature, 96), v)
        }

        // Convert sig struct to bytes
        (bool success, bytes memory result) = target.staticcall(
            abi.encodeWithSelector(IERC1271.isValidSignature.selector, sighash, signature)
        );
        return (success && result.length == 32 && abi.decode(result, (bytes4)) == IERC1271.isValidSignature.selector);
    }

    /**
     * @notice Reports whether the signer matches the target or is approved by the target.
     *
     * @param target                        The grantor of permission.
     * @param signer                        The grantee of permission.
     *
     * @return isSelfOrApproved             Whether the signer is either the grantor themselves, or approved.
     */
    function isSelfOrApproved(address target, address signer) public view override returns (bool) {
        return target == signer || isApproved(target, signer);
    }

    // ==================================== SIGNATURE VERIFICATION ======================================

    /**
     * @notice Determine the external signer for a signature specifying only a collateral address and ID.
     *
     * @param loanTerms                     The terms of the loan.
     * @param sig                           The signature, with v, r, s fields.
     * @param nonce                         The signature nonce.
     *
     * @return sighash                      The hash that was signed.
     * @return signer                       The address of the recovered signer.
     */
    function recoverTokenSignature(
        LoanLibrary.LoanTerms calldata loanTerms,
        Signature calldata sig,
        uint160 nonce
    ) public view override returns (bytes32 sighash, address signer) {
        bytes32 loanHash = keccak256(
            abi.encode(
                _TOKEN_ID_TYPEHASH,
                loanTerms.durationSecs,
                loanTerms.numInstallments,
                loanTerms.interestRate,
                loanTerms.principal,
                loanTerms.collateralAddress,
                loanTerms.collateralId,
                loanTerms.payableCurrency,
                nonce
            )
        );

        sighash = _hashTypedDataV4(loanHash);
        signer = ECDSA.recover(sighash, sig.v, sig.r, sig.s);
    }

    /**
     * @notice Determine the external signer for a signature specifying specific items.
     * @dev    Bundle ID should _not_ be included in this signature, because the loan
     *         can be initiated with any arbitrary bundle - as long as the bundle contains the items.
     *
     * @param loanTerms                     The terms of the loan.
     * @param sig                           The loan terms signature, with v, r, s fields.
     * @param nonce                         The signature nonce.
     * @param itemsHash                     The required items in the specified bundle.
     *
     * @return sighash                      The hash that was signed.
     * @return signer                       The address of the recovered signer.
     */
    function recoverItemsSignature(
        LoanLibrary.LoanTerms calldata loanTerms,
        Signature calldata sig,
        uint160 nonce,
        bytes32 itemsHash
    ) public view override returns (bytes32 sighash, address signer) {
        bytes32 loanHash = keccak256(
            abi.encode(
                _ITEMS_TYPEHASH,
                loanTerms.durationSecs,
                loanTerms.numInstallments,
                loanTerms.interestRate,
                loanTerms.principal,
                loanTerms.collateralAddress,
                itemsHash,
                loanTerms.payableCurrency,
                nonce
            )
        );

        sighash = _hashTypedDataV4(loanHash);
        signer = ECDSA.recover(sighash, sig.v, sig.r, sig.s);
    }

    // ==================================== VERIFICATION WHITELIST ======================================

    /**
     * @notice Manage whitelist for contracts that are allowed to act as a predicate verifier.
     *         Prevents counterparties from abusing misleading/obscure verification logic.
     *         The contract owner should take extra care in whitelisting third-party verification contracts:
     *         for instance, an upgradeable third-party verifier controlled by a borrower could be maliciously
     *         upgraded to approve an empty bundle.
     *
     * @param verifier              The specified verifier contract, should implement IArcadeSignatureVerifier.
     * @param isAllowed             Whether the specified contract should be allowed.
     */
    function setAllowedVerifier(address verifier, bool isAllowed) public override onlyOwner {
        if (verifier == address(0)) revert OC_ZeroAddress();

        allowedVerifiers[verifier] = isAllowed;

        emit SetAllowedVerifier(verifier, isAllowed);
    }

    /**
     * @notice Batch update for verification whitelist, in case of multiple verifiers
     *         active in production.
     *
     * @param verifiers             The list of specified verifier contracts, should implement IArcadeSignatureVerifier.
     * @param isAllowed             Whether the specified contracts should be allowed, respectively.
     */
    function setAllowedVerifierBatch(address[] calldata verifiers, bool[] calldata isAllowed) external override {
        if (verifiers.length != isAllowed.length) revert OC_BatchLengthMismatch();

        for (uint256 i = 0; i < verifiers.length; i++) {
            setAllowedVerifier(verifiers[i], isAllowed[i]);
        }
    }

    /**
     * @notice Return whether the address can be used as a verifier.
     *
     * @param verifier             The verifier contract to query.
     *
     * @return isVerified          Whether the contract is verified.
     */
    function isAllowedVerifier(address verifier) public view override returns (bool) {
        return allowedVerifiers[verifier];
    }

    // =========================================== HELPERS ==============================================

    /**
     * @dev Ensure that one counterparty has signed the loan terms, and the other
     *      has initiated the transaction.
     *
     * @param borrower                  The specified borrower for the loan.
     * @param lender                    The specified lender for the loan.
     * @param caller                    The address initiating the transaction.
     * @param signer                    The address recovered from the loan terms signature.
     * @param sig                       A struct containing the signature data (for checking EIP-1271).
     * @param sighash                   The hash of the signature payload (used for EIP-1271 check).
     */
    function _validateCounterparties(
        address borrower,
        address lender,
        address caller,
        address signer,
        Signature calldata sig,
        bytes32 sighash
    ) internal view {
        if (caller == signer) revert OC_ApprovedOwnLoan(caller);

        // Make sure one from each side approves
        if (isSelfOrApproved(lender, caller)) {
            if (!isSelfOrApproved(borrower, signer) && !isApprovedForContract(borrower, sig, sighash)) {
                revert OC_InvalidSignature(borrower, signer);
            }
        } else if (isSelfOrApproved(borrower, caller)) {
            if (!isSelfOrApproved(lender, signer) && !isApprovedForContract(lender, sig, sighash)) {
                revert OC_InvalidSignature(lender, signer);
            }
        } else {
            revert OC_CallerNotParticipant(caller);
        }
    }

    /**
     * @dev Perform loan initialization. Take custody of both principal and
     *      collateral, and tell LoanCore to create and start a loan.
     *
     * @param loanTerms                     The terms agreed by the lender and borrower.
     * @param borrower                      Address of the borrower.
     * @param lender                        Address of the lender.
     *
     * @return loanId                       The unique ID of the new loan.
     */
    function _initialize(
        LoanLibrary.LoanTerms calldata loanTerms,
        address borrower,
        address lender
    ) internal nonReentrant returns (uint256 loanId) {
        // Take custody of funds
        IERC20Upgradeable(loanTerms.payableCurrency).safeTransferFrom(lender, address(this), loanTerms.principal);
        IERC20Upgradeable(loanTerms.payableCurrency).approve(loanCore, loanTerms.principal);

        IERC721(loanTerms.collateralAddress).transferFrom(borrower, address(this), loanTerms.collateralId);
        IERC721(loanTerms.collateralAddress).approve(loanCore, loanTerms.collateralId);

        // Start loan
        loanId = ILoanCore(loanCore).startLoan(lender, borrower, loanTerms);
    }
}
