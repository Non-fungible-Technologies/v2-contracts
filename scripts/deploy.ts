import hre, { ethers, upgrades } from "hardhat";

import { ORIGINATOR_ROLE as DEFAULT_ORIGINATOR_ROLE, REPAYER_ROLE as DEFAULT_REPAYER_ROLE } from "./constants";

import {
    AssetVault,
    FeeController,
    LoanCore,
    PromissoryNote,
    RepaymentController,
    OriginationController,
    CallWhitelist,
    VaultFactory,
} from "../typechain";
export interface DeployedResources {
    assetVault: AssetVault;
    feeController: FeeController;
    loanCore: LoanCore;
    borrowerNote: PromissoryNote;
    lenderNote: PromissoryNote;
    repaymentController: RepaymentController;
    originationController: OriginationController;
    whitelist: CallWhitelist;
    vaultFactory: VaultFactory;
}

export async function main(
    ORIGINATOR_ROLE = DEFAULT_ORIGINATOR_ROLE,
    REPAYER_ROLE = DEFAULT_REPAYER_ROLE,
): Promise<DeployedResources> {
    // Hardhat always runs the compile task when running scripts through it.
    // If this runs in a standalone fashion you may want to call compile manually
    // to make sure everything is compiled
    // await run("compile");
    const CallWhiteListFactory = await ethers.getContractFactory("CallWhitelist");
    const whitelist = <CallWhitelist>await CallWhiteListFactory.deploy();

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
    const loanCore = <LoanCore>await upgrades.deployProxy(LoanCoreFactory, [feeController.address], { kind: "uups" });
    await loanCore.deployed();

    console.log("LoanCore deployed to:", loanCore.address);

    const promissoryNoteFactory = await ethers.getContractFactory("PromissoryNote");
    const borrowerNoteAddr = await loanCore.borrowerNote();
    const borrowerNote = <PromissoryNote>await promissoryNoteFactory.attach(borrowerNoteAddr);
    const lenderNoteAddr = await loanCore.lenderNote();
    const lenderNote = <PromissoryNote>await promissoryNoteFactory.attach(lenderNoteAddr);

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
        await upgrades.deployProxy(OriginationControllerFactory, [loanCore.address], { kind: "uups" })
    );

    await originationController.deployed();
    const updateOriginationControllerPermissions = await loanCore.grantRole(
        ORIGINATOR_ROLE,
        originationController.address,
    );
    await updateOriginationControllerPermissions.wait();

    console.log("OriginationController deployed to:", originationController.address);

    const VaultFactoryFactory = await ethers.getContractFactory("VaultFactory");
    // console.log("VaultFactory deployed to:", VaultFactoryFactory)
    const vaultFactory = <VaultFactory>await upgrades.deployProxy(
        VaultFactoryFactory,
        [assetVault.address, whitelist.address],
        {
            kind: "uups",
            initializer: "initialize(address, address)",
        },
    );
    console.log("VaultFactory deployed to:", vaultFactory.address);

    return {
        assetVault,
        feeController,
        loanCore,
        borrowerNote,
        lenderNote,
        repaymentController,
        originationController,
        whitelist,
        vaultFactory,
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
