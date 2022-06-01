import { ethers, upgrades } from "hardhat";

import proxyAddress from "../../.openzeppelin/ropsten.json"

import { main as writeJson } from "../utils/verify/writeJson";
import { SECTION_SEPARATOR, SUBSECTION_SEPARATOR } from "../utils/bootstrap-tools";

import {
    ORIGINATOR_ROLE as DEFAULT_ORIGINATOR_ROLE,
    REPAYER_ROLE as DEFAULT_REPAYER_ROLE,
    WRAPPED_PUNKS as DEFAULT_WRAPPED_PUNKS,
    CRYPTO_PUNKS as DEFAULT_CRYPTO_PUNKS
    } from "../utils/constants";

import {
    AssetVault,
    FeeController,
    LoanCore,
    PromissoryNote,
    RepaymentController,
    OriginationController,
    CallWhitelist,
    VaultFactory,
} from "../../typechain";

export interface deploymentData {
    [contractName: string]: contractData | PromissoryNoteTypeBn | PromissoryNoteTypeLn,
}
export interface contractData {
    contractAddress: string,
    constructorArgs: any[]
}

export interface PromissoryNoteTypeBn {
    contractAddress: string,
    constructorArgs: any[]
}

export interface PromissoryNoteTypeLn {
    contractAddress: string,
    constructorArgs: any[]
}

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
    WRAPPED_PUNKS = DEFAULT_WRAPPED_PUNKS,
    CRYPTO_PUNKS = DEFAULT_CRYPTO_PUNKS,
): Promise<DeployedResources> {
    // Hardhat always runs the compile task when running scripts through it.
    // If this runs in a standalone fashion you may want to call compile manually
    // to make sure everything is compiled
    // await run("compile");
    // const signers: SignerWithAddress[] = await hre.ethers.getSigners();
    // const [admin] = signers;
    let contractInfo: deploymentData = {}

    console.log(SECTION_SEPARATOR);

    const CallWhiteListFactory = await ethers.getContractFactory("CallWhitelist");
    const whitelist = <CallWhitelist>await CallWhiteListFactory.deploy();

    console.log("CallWhiteList deployed to:", whitelist.address);

    contractInfo["CallWhitelist"] = {
        "contractAddress": whitelist.address,

        "constructorArgs": []
    };

    console.log(SUBSECTION_SEPARATOR);

    const AssetVaultFactory = await ethers.getContractFactory("AssetVault");
    const assetVault = <AssetVault>await AssetVaultFactory.deploy();
    await assetVault.deployed();

    console.log("AssetVault deployed to:", assetVault.address);

    contractInfo["AssetVault"] = {
        "contractAddress": assetVault.address,

        "constructorArgs": []
    };

    console.log(SUBSECTION_SEPARATOR);

    const VaultFactoryFactory = await ethers.getContractFactory("VaultFactory");
    const vaultFactory = <VaultFactory>await upgrades.deployProxy(
        VaultFactoryFactory,
        [assetVault.address, whitelist.address],
        {
            kind: "uups",
            initializer: "initialize(address, address)",
        },
    );

    console.log("VaultFactory deployed to:", vaultFactory.address);

    const factoryProxyAddress = proxyAddress.proxies[0].address
    const factoryImplAddress = await upgrades.erc1967.getImplementationAddress(factoryProxyAddress)
    contractInfo["VaultFactory"] = {
        "contractAddress": factoryImplAddress,

        "constructorArgs": [assetVault.address, whitelist.address]
    };

    console.log(SUBSECTION_SEPARATOR);

    const FeeControllerFactory = await ethers.getContractFactory("FeeController");
    const feeController = <FeeController>await FeeControllerFactory.deploy();
    await feeController.deployed();

    console.log("FeeController deployed to: ", feeController.address);

    contractInfo["FeeController"] = {
        "contractAddress": feeController.address,

        "constructorArgs": []
    };

    console.log(SUBSECTION_SEPARATOR);

    const PromissoryNoteFactory = await ethers.getContractFactory("PromissoryNote");
    const borrowerNote = <PromissoryNote>await PromissoryNoteFactory.deploy("Arcade.xyz BorrowerNote", "aBN");
    await borrowerNote.deployed();

    console.log("BorrowerNote deployed to:", borrowerNote.address);

    const lenderNote = <PromissoryNote>await PromissoryNoteFactory.deploy("Arcade.xyz LenderNote", "aLN");
    await lenderNote.deployed();

    console.log("LenderNote deployed to:", lenderNote.address);

    let promissoryNoteDataBn: PromissoryNoteTypeBn = {

            "contractAddress": borrowerNote.address,

            "constructorArgs": ["Arcade.xyz BorrowerNote", "aBN"]

    };

    contractInfo["BorrowerNote"] = promissoryNoteDataBn

    let promissoryNoteDataLn: PromissoryNoteTypeLn = {

        "contractAddress": lenderNote.address,

        "constructorArgs": ["Arcade.xyz LenderNote", "aLN"]

    };

    contractInfo["LenderNote"] = promissoryNoteDataLn

    console.log(SUBSECTION_SEPARATOR);

    const LoanCoreFactory = await ethers.getContractFactory("LoanCore");
    const loanCore = <LoanCore>await upgrades.deployProxy(LoanCoreFactory, [feeController.address, borrowerNote.address, lenderNote.address], { kind: "uups" });
    await loanCore.deployed();

    console.log("LoanCore deployed to:", loanCore.address);

    const loanCoreProxyAddress = proxyAddress.proxies[1].address
    const loanCoreImplAddress = await upgrades.erc1967.getImplementationAddress(loanCoreProxyAddress);

    contractInfo["LoanCore"] = {
        "contractAddress": loanCoreImplAddress,

        "constructorArgs": [feeController.address, borrowerNote.address, lenderNote.address]
    };

    console.log(SUBSECTION_SEPARATOR);

    const RepaymentControllerFactory = await ethers.getContractFactory("RepaymentController");
    const repaymentController = <RepaymentController>(
         await RepaymentControllerFactory.deploy(loanCore.address, borrowerNote.address, lenderNote.address)
    );
    await repaymentController.deployed();

    console.log("RepaymentController deployed to:", repaymentController.address);
console.log("187 ------------------------------------------------------------------------------------------------------")
    contractInfo["RepaymentController"] = {
        "contractAddress": repaymentController.address,

        "constructorArgs": []
    };

    // const updateRepaymentControllerPermissions = await loanCore.grantRole(REPAYER_ROLE, repaymentController.address);
    // await updateRepaymentControllerPermissions.wait();
console.log("196 ------------------------------------------------------------------------------------------------------")
    console.log(SUBSECTION_SEPARATOR);

    const OriginationControllerFactory = await ethers.getContractFactory("OriginationController");
    const originationController = <OriginationController>(
        await upgrades.deployProxy(OriginationControllerFactory, [loanCore.address], { kind: "uups" })
    );
    await originationController.deployed();

    console.log("OriginationController deployed to:", originationController.address)

    const originationContProxyAddress = proxyAddress.proxies[2].address
    const originationContImplAddress = await upgrades.erc1967.getImplementationAddress(originationContProxyAddress)
    contractInfo["OriginationController"] = {
        "contractAddress": originationContImplAddress,

        "constructorArgs": [loanCore.address]
    };
console.log("212 ------------------------------------------------------------------------------------------------------")
    // const updateOriginationControllerPermissions = await loanCore.grantRole(
    //     ORIGINATOR_ROLE,
    //     originationController.address,
    // );
    // await updateOriginationControllerPermissions.wait();

    console.log(SUBSECTION_SEPARATOR);
console.log("220 ------------------------------------------------------------------------------------------------------")
    // const PunkRouterFactory = await ethers.getContractFactory("PunkRouter");
    // const punkRouter = <PunkRouter>await PunkRouterFactory.deploy(WRAPPED_PUNKS, CRYPTO_PUNKS);
    // await punkRouter.deployed();

    // console.log("PunkRouter deployed to:", punkRouter.address);

    // contractInfo["PunkRouter"] = {
    //     "contractAddress" :punkRouter.address,

    //     "constructorArgs": [WRAPPED_PUNKS, CRYPTO_PUNKS]
    // };
console.log("232 ------------------------------------------------------------------------------------------------------")
    writeJson(contractInfo)
    console.log(SECTION_SEPARATOR);

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


