import { expect } from "chai";
import hre, { ethers, waffle, upgrades } from "hardhat";
const { loadFixture } = waffle;
import { BigNumber, BigNumberish, Signer } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

import {
    LoanCore,
    FeeController,
    PromissoryNote,
    MockERC20,
    CallWhitelist,
    VaultFactory,
    AssetVault,
    LoanCoreV2Mock,
} from "../typechain";
import { BlockchainTime } from "./utils/time";
import { LoanTerms, LoanState } from "./utils/types";
import { deploy } from "./utils/contracts";
import { startLoan } from "./utils/loans";
import { ZERO_ADDRESS } from "./utils/erc20";

const ORIGINATOR_ROLE = "0x59abfac6520ec36a6556b2a4dd949cc40007459bcd5cd2507f1e5cc77b6bc97e";
const REPAYER_ROLE = "0x9c60024347074fd9de2c1e36003080d22dbc76a41ef87444d21e361bcb39118e";
const CLAIM_FEES_ROLE = "0x8dd046eb6fe22791cf064df41dbfc76ef240a563550f519aac88255bd8c2d3bb";

interface TestContext {
    loanCore: LoanCore;
    feeController: FeeController;
    vaultFactory: VaultFactory;
    mockERC20: MockERC20;
    mockBorrowerNote: PromissoryNote;
    mockLenderNote: PromissoryNote;
    borrower: SignerWithAddress;
    lender: SignerWithAddress;
    admin: SignerWithAddress;
    user: SignerWithAddress;
    other: SignerWithAddress;
    signers: Signer[];
    currentTimestamp: number;
    blockchainTime: BlockchainTime;
}

describe("LoanCore", () => {
    /**
     * Sets up a test asset vault for the user passed as an arg
     */
    const initializeBundle = async (user: Signer): Promise<BigNumber> => {
        const { vaultFactory } = await loadFixture(fixture);
        const tx = await vaultFactory.connect(user).initializeBundle(await user.getAddress());
        const receipt = await tx.wait();

        if (receipt && receipt.events) {
            for (const event of receipt.events) {
                if (event.event && event.event === "VaultCreated" && event.args && event.args.vault) {
                    return event.args.vault;
                }
            }
            throw new Error("Unable to initialize bundle");
        } else {
            throw new Error("Unable to initialize bundle");
        }
    };

    const createVault = async (factory: VaultFactory, to: Signer): Promise<AssetVault> => {
        const tx = await factory.initializeBundle(await to.getAddress());
        const receipt = await tx.wait();

        let vault: AssetVault | undefined;
        if (receipt && receipt.events) {
            for (const event of receipt.events) {
                if (event.args && event.args.vault) {
                    vault = <AssetVault>await hre.ethers.getContractAt("AssetVault", event.args.vault);
                }
            }
        } else {
            throw new Error("Unable to create new vault");
        }
        if (!vault) {
            throw new Error("Unable to create new vault");
        }
        return vault;
    };

    /**
     * Sets up a test context, deploying new contracts and returning them for use in a test
     */
    const fixture = async (): Promise<TestContext> => {
        const blockchainTime = new BlockchainTime();
        const currentTimestamp = await blockchainTime.secondsFromNow(0);
        const signers: SignerWithAddress[] = await hre.ethers.getSigners();
        const [borrower, lender, admin] = signers;

        const whitelist = <CallWhitelist>await deploy("CallWhitelist", signers[0], []);
        const vaultTemplate = <AssetVault>await deploy("AssetVault", signers[0], []);

        const VaultFactoryFactory = await hre.ethers.getContractFactory("VaultFactory");
        const vaultFactory = <VaultFactory>await upgrades.deployProxy(
            VaultFactoryFactory,
            [vaultTemplate.address, whitelist.address],
            {
                kind: "uups",
                initializer: "initialize(address, address)",
            },
        );

        const feeController = <FeeController>await deploy("FeeController", signers[0], []);

        const mockBorrowerNote = <PromissoryNote>(
            await deploy("PromissoryNote", admin, ["Arcade.xyz BorrowerNote", "aBN"])
        );
        const mockLenderNote = <PromissoryNote>await deploy("PromissoryNote", admin, ["Arcade.xyz LenderNote", "aLN"]);

        const originator = signers[0];
        const repayer = signers[0];

        const LoanCoreFactory = await hre.ethers.getContractFactory("LoanCore");
        const loanCore = <LoanCore>(
            await upgrades.deployProxy(
                LoanCoreFactory,
                [feeController.address, mockBorrowerNote.address, mockLenderNote.address],
                { kind: "uups" },
            )
        );

        // Grant correct permissions for promissory note
        for (const note of [mockBorrowerNote, mockLenderNote]) {
            await note.connect(admin).initialize(loanCore.address);
        }

        await loanCore.connect(signers[0]).grantRole(ORIGINATOR_ROLE, await originator.getAddress());
        await loanCore.connect(signers[0]).grantRole(REPAYER_ROLE, await repayer.getAddress());

        const mockERC20 = <MockERC20>await deploy("MockERC20", signers[0], ["Mock ERC20", "MOCK"]);

        return {
            loanCore,
            feeController,
            mockBorrowerNote,
            mockLenderNote,
            vaultFactory,
            mockERC20,
            borrower,
            lender,
            admin,
            user: signers[0],
            other: signers[1],
            signers: signers.slice(2),
            currentTimestamp,
            blockchainTime,
        };
    };

    /**
     * Create a legacy loan type object using the given parameters, or defaults
     */
    const createLoanTerms = (
        payableCurrency: string,
        collateralAddress: string,
        {
            durationSecs = BigNumber.from(360000),
            principal = hre.ethers.utils.parseEther("100"),
            interestRate = hre.ethers.utils.parseEther("1"),
            collateralId = 1,
            numInstallments = 0,
            deadline = 259200,
        }: Partial<LoanTerms> = {},
    ): LoanTerms => {
        return {
            durationSecs,
            principal,
            interestRate,
            collateralAddress,
            collateralId,
            payableCurrency,
            numInstallments,
            deadline,
        };
    };

    describe("Deployment", () => {
        let deployedLoanCore: LoanCore;

        beforeEach(async () => {
            const signers: SignerWithAddress[] = await hre.ethers.getSigners();
            deployedLoanCore = <LoanCore>await deploy("LoanCore", signers[0], []);
        });

        it("should not allow initialization with an invalid fee controller", async () => {
            const { mockBorrowerNote, mockLenderNote } = await loadFixture(fixture);
            const LoanCoreFactory = await hre.ethers.getContractFactory("LoanCore");

            await expect(
                upgrades.deployProxy(
                    LoanCoreFactory,
                    [ZERO_ADDRESS, mockBorrowerNote.address, mockLenderNote.address],
                    { kind: "uups" },
                ),
            ).to.be.revertedWith("LC_ZeroAddress");
        });

        it("should not allow initialization with an invalid borrower note", async () => {
            const { feeController, mockLenderNote } = await loadFixture(fixture);
            const LoanCoreFactory = await hre.ethers.getContractFactory("LoanCore");

            await expect(
                upgrades.deployProxy(LoanCoreFactory, [feeController.address, ZERO_ADDRESS, mockLenderNote.address], {
                    kind: "uups",
                }),
            ).to.be.revertedWith("LC_ZeroAddress");
        });

        it("should not allow initialization with an invalid lender note", async () => {
            const { feeController, mockBorrowerNote } = await loadFixture(fixture);
            const LoanCoreFactory = await hre.ethers.getContractFactory("LoanCore");

            await expect(
                upgrades.deployProxy(LoanCoreFactory, [feeController.address, mockBorrowerNote.address, ZERO_ADDRESS], {
                    kind: "uups",
                }),
            ).to.be.revertedWith("LC_ZeroAddress");
        });
    });

    describe("Start Loan", () => {
        interface StartLoanState extends TestContext {
            terms: LoanTerms;
            borrower: SignerWithAddress;
            lender: SignerWithAddress;
        }

        const setupLoan = async (context?: TestContext): Promise<StartLoanState> => {
            context = context || (await loadFixture(fixture));

            const { vaultFactory, mockERC20, user: borrower, other: lender } = context;
            const collateralId = await initializeBundle(borrower);
            const terms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId });
            return { ...context, terms, borrower, lender };
        };

        it("should successfully start a loan", async () => {
            const {
                mockLenderNote,
                mockBorrowerNote,
                vaultFactory,
                loanCore,
                mockERC20,
                terms,
                borrower,
                lender,
                user,
            } = await setupLoan();
            const { collateralId, principal } = terms;

            const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(await borrower.getAddress(), await borrower.getAddress(), collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(await lender.getAddress(), principal);
            await mockERC20.connect(lender).transfer(await borrower.getAddress(), principal);
            await mockERC20.connect(borrower).approve(loanCore.address, principal);

            const loanId = await startLoan(
                loanCore,
                user,
                await lender.getAddress(),
                await borrower.getAddress(),
                terms,
            );

            const fee = principal.mul(5).div(1000);
            const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.equal(principal.sub(fee));
            const loanCoreBalanceAfter = await mockERC20.balanceOf(loanCore.address);
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.equal(fee);

            const storedLoanData = await loanCore.getLoan(loanId);
            expect(storedLoanData.state).to.equal(LoanState.Active);
            expect(await mockLenderNote.ownerOf(loanId)).to.equal(await lender.getAddress());
            expect(await mockBorrowerNote.ownerOf(loanId)).to.equal(await borrower.getAddress());
        });

        it("should successfully set fee controller and use new fee", async () => {
            const { mockLenderNote, mockBorrowerNote, vaultFactory, loanCore, mockERC20, terms, borrower, lender } =
                await setupLoan();
            const { collateralId, principal } = terms;

            const borrowerBalanceBefore = await mockERC20.balanceOf(await borrower.getAddress());
            const loanCoreBalanceBefore = await mockERC20.balanceOf(loanCore.address);
            const feeController = <FeeController>await deploy("FeeController", borrower, []);
            // set the fee to 1%
            await feeController.connect(borrower).setOriginationFee(100);
            await loanCore.setFeeController(feeController.address);

            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(await borrower.getAddress(), await borrower.getAddress(), collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(await lender.getAddress(), principal);
            await mockERC20.connect(lender).transfer(await borrower.getAddress(), principal);
            await mockERC20.connect(borrower).approve(loanCore.address, principal);

            const loanId = await startLoan(
                loanCore,
                borrower,
                await lender.getAddress(),
                await borrower.getAddress(),
                terms,
            );

            // ensure the 1% fee was used
            const fee = principal.mul(1).div(100);
            const borrowerBalanceAfter = await mockERC20.balanceOf(await borrower.getAddress());
            expect(borrowerBalanceAfter.sub(borrowerBalanceBefore)).to.equal(principal.sub(fee));
            const loanCoreBalanceAfter = await mockERC20.balanceOf(loanCore.address);
            expect(loanCoreBalanceAfter.sub(loanCoreBalanceBefore)).to.equal(fee);

            const storedLoanData = await loanCore.getLoan(loanId);
            expect(storedLoanData.state).to.equal(LoanState.Active);
            expect(await mockLenderNote.ownerOf(loanId)).to.equal(await lender.getAddress());
            expect(await mockBorrowerNote.ownerOf(loanId)).to.equal(await borrower.getAddress());
        });

        it("should successfully start two loans back to back", async () => {
            const context = await loadFixture(fixture);
            const { vaultFactory, loanCore, mockERC20 } = context;
            let { terms, borrower, lender } = await setupLoan(context);
            let { collateralId, principal } = terms;

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(await borrower.getAddress(), await borrower.getAddress(), collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(await lender.getAddress(), principal);
            await mockERC20.connect(lender).transfer(await borrower.getAddress(), principal);
            await mockERC20.connect(borrower).approve(loanCore.address, principal);

            await startLoan(loanCore, borrower, await lender.getAddress(), await borrower.getAddress(), terms);

            ({ terms, borrower, lender } = await setupLoan(context));
            ({ collateralId, principal } = terms);

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(await borrower.getAddress(), await borrower.getAddress(), collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(await lender.getAddress(), principal);
            await mockERC20.connect(lender).transfer(await borrower.getAddress(), principal);
            await mockERC20.connect(borrower).approve(loanCore.address, principal);

            await startLoan(loanCore, borrower, await lender.getAddress(), await borrower.getAddress(), terms);
        });

        it("should fail to start two loans where principal for both is paid at once", async () => {
            const context = await loadFixture(fixture);
            const { vaultFactory, loanCore, mockERC20 } = context;
            let { terms, borrower, lender } = await setupLoan(context);
            let { collateralId, principal } = terms;

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(await borrower.getAddress(), await borrower.getAddress(), collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(await lender.getAddress(), principal);
            await mockERC20.connect(lender).transfer(await borrower.getAddress(), principal);
            await mockERC20.connect(borrower).approve(loanCore.address, principal);

            await startLoan(loanCore, borrower, await lender.getAddress(), await borrower.getAddress(), terms);

            ({ terms, borrower, lender } = await setupLoan(context));
            ({ collateralId, principal } = terms);

            await vaultFactory
                .connect(borrower)
                .transferFrom(await borrower.getAddress(), await borrower.getAddress(), collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            // fails because the full input from the first loan was factored into the stored contract balance
            await expect(
                loanCore.connect(borrower).startLoan(await lender.getAddress(), await borrower.getAddress(), terms),
            ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
        });

        it("rejects calls from non-originator", async () => {
            const { loanCore, user: borrower, other: lender, terms } = await setupLoan();
            await expect(
                loanCore.connect(lender).startLoan(await borrower.getAddress(), await lender.getAddress(), terms),
            ).to.be.revertedWith(
                `AccessControl: account ${(
                    await lender.getAddress()
                ).toLowerCase()} is missing role ${ORIGINATOR_ROLE}`,
            );
        });

        it("should fail to start a loan that is already started", async () => {
            const { vaultFactory, loanCore, mockERC20, terms, borrower, lender } = await setupLoan();
            const { collateralId, principal } = terms;

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(await borrower.getAddress(), await borrower.getAddress(), collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(await lender.getAddress(), principal);
            await mockERC20.connect(lender).transfer(await borrower.getAddress(), principal);
            await mockERC20.connect(borrower).approve(loanCore.address, principal);

            await loanCore.connect(borrower).startLoan(await lender.getAddress(), await borrower.getAddress(), terms);
            await expect(
                loanCore.connect(borrower).startLoan(await lender.getAddress(), await borrower.getAddress(), terms),
            ).to.be.revertedWith("LC_CollateralInUse");
        });

        it("should fail to start a loan that is repaid", async () => {
            const { vaultFactory, loanCore, mockERC20, terms, borrower, lender } = await setupLoan();
            const { collateralId, principal, interestRate } = terms;

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(await borrower.getAddress(), await borrower.getAddress(), collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);
            await mockERC20.connect(lender).mint(await lender.getAddress(), principal);
            await mockERC20.connect(lender).transfer(await borrower.getAddress(), principal);
            await mockERC20.connect(borrower).approve(loanCore.address, principal);

            const loanId = await startLoan(
                loanCore,
                borrower,
                await lender.getAddress(),
                await borrower.getAddress(),
                terms,
            );

            await mockERC20.connect(borrower).mint(await borrower.getAddress(), principal.add(interestRate));
            await mockERC20.connect(borrower).approve(loanCore.address, principal.add(interestRate));

            await loanCore.connect(borrower).repay(loanId);

            // Originator no longer owns collateral
            await expect(
                loanCore.connect(borrower).startLoan(await lender.getAddress(), await borrower.getAddress(), terms),
            ).to.be.revertedWith("ERC721: transfer caller is not owner nor approved");
        });

        it("should fail to start a loan that is already claimed", async () => {
            const { vaultFactory, loanCore, mockERC20, terms, borrower, lender, blockchainTime } = await setupLoan();
            const { collateralId, principal, interestRate } = terms;

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(await borrower.getAddress(), await borrower.getAddress(), collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(await lender.getAddress(), principal);
            await mockERC20.connect(lender).transfer(await borrower.getAddress(), principal);
            await mockERC20.connect(borrower).approve(loanCore.address, principal);

            const loanId = await startLoan(
                loanCore,
                borrower,
                await lender.getAddress(),
                await borrower.getAddress(),
                terms,
            );

            await mockERC20.connect(borrower).mint(loanCore.address, principal.add(interestRate));

            await blockchainTime.increaseTime(360001);

            await loanCore.connect(borrower).claim(loanId, BigNumber.from(0));
            await expect(
                loanCore.connect(borrower).startLoan(await lender.getAddress(), await borrower.getAddress(), terms),
            ).to.be.revertedWith("ERC721: transfer caller is not owner nor approved");
        });

        it("should fail to start a loan if collateral has not been sent", async () => {
            const { loanCore, terms, borrower, lender } = await setupLoan();
            await expect(
                loanCore.connect(borrower).startLoan(await lender.getAddress(), await borrower.getAddress(), terms),
            ).to.be.revertedWith("ERC721: transfer caller is not owner nor approved");
        });

        it("should fail to start a loan if lender did not deposit", async () => {
            const { vaultFactory, loanCore, terms, borrower, lender } = await setupLoan();
            const { collateralId } = terms;
            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(await borrower.getAddress(), await borrower.getAddress(), collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await expect(
                loanCore.connect(borrower).startLoan(await lender.getAddress(), await borrower.getAddress(), terms),
            ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
        });

        it("should fail to start a loan if lender did not deposit enough", async () => {
            const { vaultFactory, loanCore, mockERC20, terms, borrower, lender } = await setupLoan();
            const { collateralId, principal } = terms;

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(await borrower.getAddress(), await borrower.getAddress(), collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(await lender.getAddress(), principal);
            await mockERC20.connect(lender).transfer(await borrower.getAddress(), principal.sub(1));
            await mockERC20.connect(borrower).approve(loanCore.address, principal);

            await expect(
                loanCore.connect(borrower).startLoan(await lender.getAddress(), await borrower.getAddress(), terms),
            ).to.be.revertedWith("ERC20: transfer amount exceeds balance");
        });

        it("should fail when paused", async () => {
            const { vaultFactory, loanCore, mockERC20, terms, borrower, lender } = await setupLoan();

            const { collateralId, principal } = terms;

            await vaultFactory
                .connect(borrower)
                .transferFrom(await borrower.getAddress(), loanCore.address, collateralId);
            await mockERC20.connect(lender).mint(loanCore.address, principal);

            await loanCore.connect(borrower).pause();
            await expect(
                loanCore.connect(borrower).startLoan(await lender.getAddress(), await borrower.getAddress(), terms),
            ).to.be.revertedWith("Pausable: paused");
        });
    });

    describe("Repay Loan", function () {
        interface RepayLoanState extends TestContext {
            loanId: BigNumberish;
            terms: LoanTerms;
            borrower: SignerWithAddress;
            lender: SignerWithAddress;
        }

        const setupLoan = async (context?: TestContext): Promise<RepayLoanState> => {
            context = context || (await loadFixture(fixture));

            const { vaultFactory, mockERC20, loanCore, user: borrower, other: lender } = context;
            const collateralId = await initializeBundle(borrower);

            const terms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId });

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(await borrower.getAddress(), await borrower.getAddress(), collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(await lender.getAddress(), terms.principal);
            await mockERC20.connect(lender).transfer(await borrower.getAddress(), terms.principal);
            await mockERC20.connect(borrower).approve(loanCore.address, terms.principal);

            const loanId = await startLoan(
                loanCore,
                borrower,
                await lender.getAddress(),
                await borrower.getAddress(),
                terms,
            );

            return { ...context, loanId, terms, borrower, lender };
        };

        it("should successfully repay loan", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms } = await setupLoan();
            await mockERC20
                .connect(borrower)
                .mint(await borrower.getAddress(), terms.principal.add(terms.interestRate));
            await mockERC20.connect(borrower).approve(loanCore.address, terms.principal.add(terms.interestRate));
            await expect(loanCore.connect(borrower).repay(loanId)).to.emit(loanCore, "LoanRepaid").withArgs(loanId);
        });

        it("rejects calls from non-repayer", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, other, terms } = await setupLoan();
            await mockERC20.connect(borrower).mint(loanCore.address, terms.principal.add(terms.interestRate));

            await expect(loanCore.connect(other).repay(loanId)).to.be.revertedWith(
                `AccessControl: account ${(await other.getAddress()).toLowerCase()} is missing role ${REPAYER_ROLE}`,
            );
        });

        it("should update repayer address and work with new one", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, other, terms } = await setupLoan();
            await mockERC20
                .connect(borrower)
                .mint(await borrower.getAddress(), terms.principal.add(terms.interestRate));
            await mockERC20
                .connect(borrower)
                .transfer(await other.getAddress(), terms.principal.add(terms.interestRate));
            await mockERC20.connect(other).approve(loanCore.address, terms.principal.add(terms.interestRate));
            await loanCore.grantRole(REPAYER_ROLE, await other.getAddress());
            await expect(loanCore.connect(other).repay(loanId)).to.emit(loanCore, "LoanRepaid").withArgs(loanId);
        });

        it("should fail if the loan does not exist", async () => {
            const { loanCore, user: borrower } = await setupLoan();
            const loanId = "123412341324";
            await expect(loanCore.connect(borrower).repay(loanId)).to.be.revertedWith("LC_InvalidState");
        });

        it("should fail if the loan is not active", async () => {
            const { loanCore, user: borrower, terms } = await setupLoan();
            const collateralId = await initializeBundle(borrower);
            terms.collateralId = collateralId;
            const loanId = 1000;
            await expect(loanCore.connect(borrower).repay(loanId)).to.be.revertedWith("LC_InvalidState");
        });

        it("should fail if the loan is already repaid", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms } = await setupLoan();
            await mockERC20
                .connect(borrower)
                .mint(await borrower.getAddress(), terms.principal.add(terms.interestRate));
            await mockERC20.connect(borrower).approve(loanCore.address, terms.principal.add(terms.interestRate));

            await loanCore.connect(borrower).repay(loanId);
            await expect(loanCore.connect(borrower).repay(loanId)).to.be.revertedWith("LC_InvalidState");
        });

        it("should fail if the loan is already claimed", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms, blockchainTime } = await setupLoan();
            await mockERC20.connect(borrower).mint(loanCore.address, terms.principal.add(terms.interestRate));
            await blockchainTime.increaseTime(360001);

            await expect(loanCore.connect(borrower).repay(loanId)).to.be.revertedWith(
                "ERC20: transfer amount exceeds balance",
            );
        });

        it("should fail if the debt was not repaid", async () => {
            const { loanId, loanCore, user: borrower } = await setupLoan();

            await expect(loanCore.connect(borrower).repay(loanId)).to.be.revertedWith(
                "ERC20: transfer amount exceeds balance",
            );
        });

        it("should fail if the debt was not repaid in full", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms } = await setupLoan();
            await mockERC20.connect(borrower).mint(loanCore.address, terms.principal.sub(1));

            await expect(loanCore.connect(borrower).repay(loanId)).to.be.revertedWith(
                "ERC20: transfer amount exceeds balance",
            );
        });

        it("should fail if the interest was not paid in full", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms } = await setupLoan();
            await mockERC20.connect(borrower).mint(loanCore.address, terms.principal.add(terms.interestRate).sub(1));

            await expect(loanCore.connect(borrower).repay(loanId)).to.be.revertedWith(
                "ERC20: transfer amount exceeds balance",
            );
        });

        it("should still work when paused", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms } = await setupLoan();
            await mockERC20
                .connect(borrower)
                .mint(await borrower.getAddress(), terms.principal.add(terms.interestRate));
            await mockERC20.connect(borrower).approve(loanCore.address, terms.principal.add(terms.interestRate));
            await expect(loanCore.connect(borrower).repay(loanId)).to.emit(loanCore, "LoanRepaid").withArgs(loanId);
        });
    });

    describe("Claim loan (no installments)", async function () {
        interface RepayLoanState extends TestContext {
            loanId: BigNumberish;
            terms: LoanTerms;
            borrower: SignerWithAddress;
            lender: SignerWithAddress;
        }

        const setupLoan = async (context?: TestContext): Promise<RepayLoanState> => {
            context = context || (await loadFixture(fixture));

            const { vaultFactory, mockERC20, loanCore, user: borrower, other: lender } = context;
            const collateralId = await initializeBundle(borrower);

            const terms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId });

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(await borrower.getAddress(), await borrower.getAddress(), collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(await lender.getAddress(), terms.principal);
            await mockERC20.connect(lender).transfer(await borrower.getAddress(), terms.principal);
            await mockERC20.connect(borrower).approve(loanCore.address, terms.principal);

            const loanId = await startLoan(
                loanCore,
                borrower,
                await lender.getAddress(),
                await borrower.getAddress(),
                terms,
            );

            return { ...context, loanId, terms, borrower, lender };
        };

        it("should successfully claim loan", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms, blockchainTime } = await setupLoan();

            await mockERC20.connect(borrower).mint(loanCore.address, terms.principal.add(terms.interestRate));

            await blockchainTime.increaseTime(360001);

            await expect(loanCore.connect(borrower).claim(loanId, BigNumber.from(0)))
                .to.emit(loanCore, "LoanClaimed")
                .withArgs(loanId);
        });

        it("Rejects calls from non-repayer", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, other, terms, blockchainTime } = await setupLoan();

            await mockERC20.connect(borrower).mint(loanCore.address, terms.principal.add(terms.interestRate));
            await blockchainTime.increaseTime(360001);

            await expect(loanCore.connect(other).claim(loanId, BigNumber.from(0))).to.be.revertedWith(
                `AccessControl: account ${(await other.getAddress()).toLowerCase()} is missing role ${REPAYER_ROLE}`,
            );
        });

        it("should fail if loan doesnt exist", async () => {
            const { loanCore, user: borrower } = await setupLoan();
            const loanId = "123412341324";
            await expect(loanCore.connect(borrower).claim(loanId, 0)).to.be.revertedWith("LC_InvalidState");
        });

        it("should fail if the loan is not active", async () => {
            const { loanCore, user: borrower, terms } = await setupLoan();
            const collateralId = await initializeBundle(borrower);
            terms.collateralId = collateralId;
            const loanId = 100;
            await expect(loanCore.connect(borrower).claim(loanId, 0)).to.be.revertedWith("LC_InvalidState");
        });

        it("should fail if the loan is already repaid", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms } = await setupLoan();
            await mockERC20
                .connect(borrower)
                .mint(await borrower.getAddress(), terms.principal.add(terms.interestRate));
            await mockERC20.connect(borrower).approve(loanCore.address, terms.principal.add(terms.interestRate));

            await loanCore.connect(borrower).repay(loanId);
            await expect(loanCore.connect(borrower).claim(loanId, 0)).to.be.revertedWith("LC_InvalidState");
        });

        it("should fail if the loan is already claimed", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms, blockchainTime } = await setupLoan();

            await mockERC20.connect(borrower).mint(loanCore.address, terms.principal.add(terms.interestRate));

            await blockchainTime.increaseTime(360001);

            await loanCore.connect(borrower).claim(loanId, 0);
            await expect(loanCore.connect(borrower).claim(loanId, 0)).to.be.revertedWith("LC_InvalidState");
        });

        it("should fail if the loan is not expired", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms } = await setupLoan();
            await mockERC20.connect(borrower).mint(loanCore.address, terms.principal.add(terms.interestRate));

            await expect(loanCore.connect(borrower).claim(loanId, BigNumber.from(0))).to.be.revertedWith(
                "LC_NotExpired",
            );
        });

        it("should fail when paused", async () => {
            const { mockERC20, loanId, loanCore, user: borrower, terms, blockchainTime } = await setupLoan();
            await mockERC20.connect(borrower).mint(loanCore.address, terms.principal.add(terms.interestRate));

            await blockchainTime.increaseTime(360001);

            await loanCore.connect(borrower).pause();
            await expect(loanCore.connect(borrower).claim(loanId, BigNumber.from(0))).to.be.revertedWith(
                "Pausable: paused",
            );
        });

        it("pause, unPause, make tx", async () => {
            const {
                mockERC20,
                loanId,
                loanCore,
                other: lender,
                user: borrower,
                terms,
                blockchainTime,
            } = await setupLoan();
            await mockERC20.connect(borrower).mint(loanCore.address, terms.principal.add(terms.interestRate));

            await blockchainTime.increaseTime(360001);
            await loanCore.connect(borrower).pause();

            await blockchainTime.increaseTime(100);
            await loanCore.connect(borrower).unpause();

            await expect(loanCore.connect(borrower).claim(loanId, BigNumber.from(0)))
                .to.emit(loanCore, "LoanClaimed")
                .withArgs(loanId);
        });
    });

    describe("Claim fees", async () => {
        interface StartLoanState extends TestContext {
            terms: LoanTerms;
            borrower: SignerWithAddress;
            lender: SignerWithAddress;
        }

        const setupLoan = async (context?: TestContext): Promise<StartLoanState> => {
            context = context || (await loadFixture(fixture));

            const { vaultFactory, mockERC20, user: borrower, other: lender } = context;
            const collateralId = await initializeBundle(borrower);

            const terms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId });

            return { ...context, terms, borrower, lender };
        };

        it("should successfully claim fees", async () => {
            const { vaultFactory, loanCore, mockERC20, terms, borrower, lender } = await setupLoan();
            const { collateralId, principal } = terms;

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(await borrower.getAddress(), await borrower.getAddress(), collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(await lender.getAddress(), principal);
            await mockERC20.connect(lender).transfer(await borrower.getAddress(), principal);
            await mockERC20.connect(borrower).approve(loanCore.address, principal);

            await startLoan(loanCore, borrower, await lender.getAddress(), await borrower.getAddress(), terms);

            const fee = principal.mul(5).div(1000);
            expect(await mockERC20.balanceOf(loanCore.address)).to.equal(fee);
            await expect(loanCore.connect(borrower).claimFees(mockERC20.address))
                .to.emit(loanCore, "FeesClaimed")
                .withArgs(mockERC20.address, await borrower.getAddress(), fee);
            expect(await mockERC20.balanceOf(loanCore.address)).to.equal(0);
        });

        it("should fail for anyone other than the admin", async () => {
            const { vaultFactory, loanCore, mockERC20, terms, borrower, lender } = await setupLoan();
            const { collateralId, principal } = terms;

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(await borrower.getAddress(), await borrower.getAddress(), collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(await lender.getAddress(), principal);
            await mockERC20.connect(lender).transfer(await borrower.getAddress(), principal);
            await mockERC20.connect(borrower).approve(loanCore.address, principal);

            await startLoan(loanCore, borrower, await lender.getAddress(), await borrower.getAddress(), terms);

            const fee = principal.mul(5).div(1000);
            expect(await mockERC20.balanceOf(loanCore.address)).to.equal(fee);
            await expect(loanCore.connect(lender).claimFees(mockERC20.address)).to.be.revertedWith(
                `AccessControl: account ${(
                    await lender.getAddress()
                ).toLowerCase()} is missing role ${CLAIM_FEES_ROLE}`,
            );
        });

        it("only fee claimer should be able to change fee claimer", async () => {
            const { vaultFactory, loanCore, mockERC20, terms, borrower, lender } = await setupLoan();
            const { collateralId, principal } = terms;

            // run originator controller logic inline then invoke loanCore
            // borrower is originator with originator role
            await vaultFactory
                .connect(borrower)
                .transferFrom(await borrower.getAddress(), await borrower.getAddress(), collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(await lender.getAddress(), principal);
            await mockERC20.connect(lender).transfer(await borrower.getAddress(), principal);
            await mockERC20.connect(borrower).approve(loanCore.address, principal);

            await startLoan(loanCore, borrower, await lender.getAddress(), await borrower.getAddress(), terms);

            await loanCore.connect(borrower).grantRole(CLAIM_FEES_ROLE, await lender.getAddress());
            await loanCore.connect(borrower).revokeRole(CLAIM_FEES_ROLE, await borrower.getAddress());
            await expect(
                loanCore.connect(borrower).grantRole(CLAIM_FEES_ROLE, await borrower.getAddress()),
            ).to.be.revertedWith(
                `AccessControl: account ${(
                    await borrower.getAddress()
                ).toLowerCase()} is missing role ${CLAIM_FEES_ROLE}`,
            );
        });
    });

    describe("canCallOn", function () {
        interface StartLoanState extends TestContext {
            loanId: BigNumberish;
            terms: LoanTerms;
            borrower: SignerWithAddress;
            lender: SignerWithAddress;
        }

        const setupLoan = async (): Promise<StartLoanState> => {
            const context = await loadFixture(fixture);

            const { vaultFactory, mockERC20, loanCore, user: borrower, other: lender } = context;
            const collateralId = await initializeBundle(borrower);
            const terms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId });

            await vaultFactory
                .connect(borrower)
                .transferFrom(await borrower.getAddress(), await borrower.getAddress(), collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await createVault(vaultFactory, borrower);

            await mockERC20.connect(lender).mint(await lender.getAddress(), terms.principal);
            await mockERC20.connect(lender).transfer(await borrower.getAddress(), terms.principal);
            await mockERC20.connect(borrower).approve(loanCore.address, terms.principal);

            const loanId = await startLoan(
                loanCore,
                borrower,
                await lender.getAddress(),
                await borrower.getAddress(),
                terms,
            );

            return { ...context, loanId, terms, borrower, lender };
        };

        it("should return true for borrower on vault in use as collateral", async () => {
            const {
                loanCore,
                loanId,
                borrower,
                terms: { collateralId },
            } = await setupLoan();

            const storedLoanData = await loanCore.getLoan(loanId);
            expect(storedLoanData.state).to.equal(LoanState.Active);

            expect(await loanCore.canCallOn(await borrower.getAddress(), collateralId.toString())).to.be.true;
        });

        it("should return true for any vaults if borrower has several", async () => {
            const context = await loadFixture(fixture);

            const { vaultFactory, mockERC20, loanCore, user: borrower, other: lender } = context;
            const collateralId = await initializeBundle(borrower);
            const terms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId });

            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await mockERC20.connect(lender).mint(await lender.getAddress(), terms.principal);
            await mockERC20.connect(lender).transfer(await borrower.getAddress(), terms.principal);
            await mockERC20.connect(borrower).approve(loanCore.address, terms.principal);

            await startLoan(loanCore, borrower, await lender.getAddress(), await borrower.getAddress(), terms);

            const collateralId2 = await initializeBundle(borrower);
            const terms2 = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId: collateralId2 });

            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId2);

            await mockERC20.connect(lender).mint(await lender.getAddress(), terms2.principal);
            await mockERC20.connect(lender).transfer(await borrower.getAddress(), terms2.principal);
            await mockERC20.connect(borrower).approve(loanCore.address, terms2.principal);

            await startLoan(loanCore, borrower, await lender.getAddress(), await borrower.getAddress(), terms2);

            expect(await loanCore.canCallOn(await borrower.getAddress(), collateralId.toString())).to.be.true;
            expect(await loanCore.canCallOn(await borrower.getAddress(), collateralId2.toString())).to.be.true;
        });

        it("should return false for irrelevant user and vault", async () => {
            const context = await loadFixture(fixture);

            const { vaultFactory, loanCore, user: borrower, signers } = context;
            const collateralId = await initializeBundle(borrower);

            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            expect(await loanCore.canCallOn(await signers[2].getAddress(), collateralId.toString())).to.be.false;
        });

        it("should return false for irrelevant user on vault in use as collateral", async () => {
            const {
                loanCore,
                signers,
                terms: { collateralId },
            } = await setupLoan();

            expect(await loanCore.canCallOn(await signers[2].getAddress(), collateralId.toString())).to.be.false;
        });

        it("should return false for lender user on vault in use as collateral", async () => {
            const {
                loanCore,
                loanId,
                lender,
                terms: { collateralId },
            } = await setupLoan();

            const storedLoanData = await loanCore.getLoan(loanId);
            expect(storedLoanData.state).to.equal(LoanState.Active);

            expect(await loanCore.canCallOn(await lender.getAddress(), collateralId.toString())).to.be.false;
        });
    });

    describe("setFeeController", async () => {
        it("should revert if the caller is not the owner", async () => {
            const { loanCore, lender } = await loadFixture(fixture);

            await expect(loanCore.connect(lender).setFeeController(lender.address)).to.be.revertedWith(
                `AccessControl: account ${lender.address.toLowerCase()} is missing role 0x8dd046eb6fe22791cf064df41dbfc76ef240a563550f519aac88255bd8c2d3bb`,
            );
        });

        it("should revert if provided an invalid fee controller address", async () => {
            const { loanCore } = await loadFixture(fixture);

            await expect(loanCore.setFeeController(ZERO_ADDRESS)).to.be.revertedWith("LC_ZeroAddress");
        });
    });

    describe("Upgradeable", async () => {
        interface StartLoanState extends TestContext {
            loanId: BigNumberish;
            terms: LoanTerms;
            borrower: SignerWithAddress;
            lender: SignerWithAddress;
        }

        const setupLoan = async (): Promise<StartLoanState> => {
            const context = await loadFixture(fixture);

            const { vaultFactory, mockERC20, loanCore, user: borrower, other: lender } = context;
            const collateralId = await initializeBundle(borrower);
            const terms = createLoanTerms(mockERC20.address, vaultFactory.address, { collateralId });

            await vaultFactory
                .connect(borrower)
                .transferFrom(await borrower.getAddress(), await borrower.getAddress(), collateralId);
            await vaultFactory.connect(borrower).approve(loanCore.address, collateralId);

            await createVault(vaultFactory, borrower);

            await mockERC20.connect(lender).mint(await lender.getAddress(), terms.principal);
            await mockERC20.connect(lender).transfer(await borrower.getAddress(), terms.principal);
            await mockERC20.connect(borrower).approve(loanCore.address, terms.principal);

            const loanId = await startLoan(
                loanCore,
                borrower,
                await lender.getAddress(),
                await borrower.getAddress(),
                terms,
            );

            return { ...context, loanId, terms, borrower, lender };
        };

        it("maintains state: confirms that v1 loans still exist after upgrading to v2", async () => {
            const { loanCore, loanId } = await setupLoan();

            const storedLoanData = await loanCore.getLoan(loanId);
            expect(storedLoanData.state).to.equal(LoanState.Active);
            // READS LOAN STATE FROM V2 (loanCoreV2Mock) ////////////

            const LoanCoreV2MockFactory = await hre.ethers.getContractFactory("LoanCoreV2Mock");
            const loanCoreV2Mock = <LoanCoreV2Mock>(
                await hre.upgrades.upgradeProxy(loanCore.address, LoanCoreV2MockFactory)
            );

            // UPGRADES TO V2 (loanCoreV2Mock) /////////////////////////////
            expect(await loanCoreV2Mock.version()).to.equal("This is LoanCore V2!");

            const v2StoredLoanData = await loanCoreV2Mock.getLoan(loanId);
            expect(v2StoredLoanData.state).to.equal(LoanState.Active);
        });
    });

    describe("Nonce management", () => {
        let context: TestContext;

        beforeEach(async () => {
            context = await loadFixture(fixture);
        });

        it("does not let a nonce be consumed by a non-originator", async () => {
            const { loanCore, other, user } = context;
            await expect(loanCore.connect(other).consumeNonce(await user.getAddress(), 10)).to.be.revertedWith(
                `AccessControl: account ${await (
                    await other.getAddress()
                ).toLocaleLowerCase()} is missing role ${ORIGINATOR_ROLE}`,
            );
        });

        it("consumes a nonce", async () => {
            const { loanCore, user } = context;

            await expect(loanCore.connect(user).consumeNonce(user.address, 10)).to.not.be.reverted;

            expect(await loanCore.isNonceUsed(user.address, 10)).to.be.true;
            expect(await loanCore.isNonceUsed(user.address, 20)).to.be.false;
        });

        it("reverts if attempting to use a nonce that has already been consumed", async () => {
            const { loanCore, user } = context;

            await expect(loanCore.connect(user).consumeNonce(user.address, 10)).to.not.be.reverted;

            await expect(loanCore.connect(user).consumeNonce(user.address, 10)).to.be.revertedWith("LC_NonceUsed");
        });

        it("cancels a nonce", async () => {
            const { loanCore, user } = context;

            await expect(loanCore.connect(user).cancelNonce(10)).to.not.be.reverted;

            expect(await loanCore.isNonceUsed(user.address, 10)).to.be.true;
            expect(await loanCore.isNonceUsed(user.address, 20)).to.be.false;
        });

        it("reverts if attempting to use a nonce that has already been cancelled", async () => {
            const { loanCore, user } = context;

            await expect(loanCore.connect(user).cancelNonce(10)).to.not.be.reverted;

            await expect(loanCore.connect(user).consumeNonce(user.address, 10)).to.be.revertedWith("LC_NonceUsed");
        });
    });
});
