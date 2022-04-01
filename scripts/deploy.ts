import { ethers } from "hardhat";

import { ORIGINATOR_ROLE as DEFAULT_ORIGINATOR_ROLE, REPAYER_ROLE as DEFAULT_REPAYER_ROLE } from "./constants";

import {
    AssetWrapper,
    FeeController,
    LoanCore,
    PromissoryNote,
    RepaymentController,
    OriginationController,
    FlashRollover,
    PunkRouter
} from "../typechain";
export interface DeployedResources {
    assetWrapper: AssetWrapper;
    feeController: FeeController;
    loanCore: LoanCore;
    borrowerNote: PromissoryNote;
    lenderNote: PromissoryNote;
    repaymentController: RepaymentController;
    originationController: OriginationController;
}

export async function main(
    ORIGINATOR_ROLE = DEFAULT_ORIGINATOR_ROLE,
    REPAYER_ROLE = DEFAULT_REPAYER_ROLE,
): Promise<DeployedResources> {
    // Hardhat always runs the compile task when running scripts through it.
    // If this runs in a standalone fashion you may want to call compile manually
    // to make sure everything is compiled
    // await run("compile");

    // We get the contract to deploy
    const AssetWrapperFactory = await ethers.getContractFactory("AssetWrapper");
    const assetWrapper = <AssetWrapper>await AssetWrapperFactory.deploy("AssetWrapper", "AW");
    await assetWrapper.deployed();

    console.log("AssetWrapper deployed to:", assetWrapper.address);

    const FeeControllerFactory = await ethers.getContractFactory("FeeController");
    const feeController = <FeeController>await FeeControllerFactory.deploy();
    await feeController.deployed();

    console.log("FeeController deployed to: ", feeController.address);

    const LoanCoreFactory = await ethers.getContractFactory("LoanCore");
    const loanCore = <LoanCore>await LoanCoreFactory.deploy(assetWrapper.address, feeController.address);
    await loanCore.deployed();

    const promissoryNoteFactory = await ethers.getContractFactory("PromissoryNote");
    const borrowerNoteAddr = await loanCore.borrowerNote();
    const borrowerNote = <PromissoryNote>await promissoryNoteFactory.attach(borrowerNoteAddr);
    const lenderNoteAddr = await loanCore.lenderNote();
    const lenderNote = <PromissoryNote>await promissoryNoteFactory.attach(lenderNoteAddr);

    console.log("LoanCore deployed to:", loanCore.address);
    console.log("BorrowerNote deployed to:", borrowerNoteAddr);
    console.log("LenderNote deployed to:", lenderNoteAddr);

    const RepaymentControllerFactory = await ethers.getContractFactory("RepaymentController");
    const repaymentController = <RepaymentController>(
        await RepaymentControllerFactory.deploy(loanCore.address, borrowerNoteAddr, lenderNoteAddr)
    );
    await repaymentController.deployed();
    const updateRepaymentControllerPermissions = await loanCore.grantRole(REPAYER_ROLE, repaymentController.address);
    await updateRepaymentControllerPermissions.wait();

    console.log("RepaymentController deployed to:", repaymentController.address);

    const OriginationControllerFactory = await ethers.getContractFactory("OriginationController");
    const originationController = <OriginationController>(
        await OriginationControllerFactory.deploy(loanCore.address, assetWrapper.address)
    );
    await originationController.deployed();
    const updateOriginationControllerPermissions = await loanCore.grantRole(
        ORIGINATOR_ROLE,
        originationController.address,
    );
    await updateOriginationControllerPermissions.wait();

    console.log("OriginationController deployed to:", originationController.address);

    const WRAPPED_PUNKS = "0xb7F7F6C52F2e2fdb1963Eab30438024864c313F6";
    const CRYPTO_PUNKS = "0xb47e3cd837ddf8e4c57f05d70ab865de6e193bbb";
    const PunkRouter = await ethers.getContractFactor("PunkRouter");
    const punkRouter = await PunkRouter.deploy(assetWrapper.address, WRAPPED_PUNKS, CRYPTO_PUNKS);
    await punkRouter.deployed();

    console.log("PunkRouter deployed to:", punkRouter.address);

    const ADDRESSES_PROVIDER_ADDRESS = "0xB53C1a33016B2DC2fF3653530bfF1848a515c8c5";

    const FlashRolloverFactory = await ethers.getContractFactory("FlashRollover");
    const flashRollover = <FlashRollover>(
        await FlashRolloverFactory.deploy(
            ADDRESSES_PROVIDER_ADDRESS
        )
    );

    await flashRollover.deployed();

    console.log("FlashRollover deployed to:", flashRollover.address);

    // Set flash rollover in asset wrapper
    await assetWrapper.setRContract(flashRollover.address);

    return {
        assetWrapper,
        feeController,
        loanCore,
        borrowerNote,
        lenderNote,
        repaymentController,
        originationController,
    };
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch((error: Error) => {
            console.error(error);
            process.exit(1);
        });
}
