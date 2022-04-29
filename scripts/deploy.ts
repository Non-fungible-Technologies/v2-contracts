import hre, { ethers, upgrades } from "hardhat";

import { ORIGINATOR_ROLE as DEFAULT_ORIGINATOR_ROLE, REPAYER_ROLE as DEFAULT_REPAYER_ROLE } from "./constants";

import {
    AssetVault,
    FeeController,
    LoanCore,
    PromissoryNote,
    RepaymentController,
    OriginationController,
} from "../typechain";
export interface DeployedResources {
   //  assetVault: AssetVault;
    // feeController: FeeController;
    loanCore: LoanCore;
    // borrowerNote: PromissoryNote;
    // lenderNote: PromissoryNote;
    // repaymentController: RepaymentController;
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
    const AssetVaultFactory = await ethers.getContractFactory("AssetVault");
    const assetVault = <AssetVault>await AssetVaultFactory.deploy();
    await assetVault.deployed();

    console.log("AssetVault deployed to:", assetVault.address);

    const FeeControllerFactory = await ethers.getContractFactory("FeeController");
    const feeController = <FeeController>await FeeControllerFactory.deploy();
    await feeController.deployed();

    console.log("FeeController deployed to: ", feeController.address);

    const LoanCoreFactory = await ethers.getContractFactory("LoanCore");
    const loanCore = <LoanCore>await LoanCoreFactory.deploy(feeController.address);
    await loanCore.deployed();

    // const promissoryNoteFactory = await ethers.getContractFactory("PromissoryNote");
    // const borrowerNoteAddr = await loanCore.borrowerNote();
    // const borrowerNote = <PromissoryNote>await promissoryNoteFactory.attach(borrowerNoteAddr);
    // const lenderNoteAddr = await loanCore.lenderNote();
    // const lenderNote = <PromissoryNote>await promissoryNoteFactory.attach(lenderNoteAddr);

    // console.log("LoanCore deployed to:", loanCore.address);
    // console.log("BorrowerNote deployed to:", borrowerNoteAddr);
    // console.log("LenderNote deployed to:", lenderNoteAddr);

    // const RepaymentControllerFactory = await ethers.getContractFactory("RepaymentController");
    // const repaymentController = <RepaymentController>(
    //     await RepaymentControllerFactory.deploy(loanCore.address, borrowerNoteAddr, lenderNoteAddr)
    // );
    // await repaymentController.deployed();
    // const updateRepaymentControllerPermissions = await loanCore.grantRole(REPAYER_ROLE, repaymentController.address);
    // await updateRepaymentControllerPermissions.wait();

    // console.log("RepaymentController deployed to:", repaymentController.address);

    const OriginationController = await hre.ethers.getContractFactory("OriginationController");
    const originationController = <OriginationController>(
        await upgrades.deployProxy(OriginationController, [loanCore.address], { kind: 'uups' })
    );
    // const originationController: OriginationController = await upgrades.deployProxy(OriginationControllerFactory, { kind: 'uups', initializer: "initialize"});
    // const originationController = <OriginationController>(
       // await OriginationControllerFactory.upgrades.deployProxy(loanCore.address, assetVault.address)
    // await originationController.initialize(loanCore.address)

    await originationController.deployed();
    const updateOriginationControllerPermissions = await loanCore.grantRole(
        ORIGINATOR_ROLE,
        originationController.address,
    );
    await updateOriginationControllerPermissions.wait();

    console.log("OriginationController deployed to:", originationController.address);

    return {
        loanCore,
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

