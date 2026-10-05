use clap::Args;
use zcash_client_backend::proto::service;

use crate::{config::get_wallet_network, remote::ConnectionArgs};

// Options accepted for the `get-info` command
#[derive(Debug, Args)]
pub(crate) struct Command {
    #[command(flatten)]
    connection: ConnectionArgs,
}

impl Command {
    pub(crate) async fn run(self, wallet_dir: Option<String>) -> Result<(), anyhow::Error> {
        let params = get_wallet_network(wallet_dir.as_ref())?;

        // The server we are about to connect to (for the reported URI).
        let server_uri = self.connection.server.pick(params)?.uri();

        let mut client = self.connection.connect(params, wallet_dir.as_ref()).await?;
        let info = client
            .get_lightd_info(service::Empty {})
            .await?
            .into_inner();

        // Stable, machine-consumed shape (see zcash_local_net's
        // `client::zcash_devtool` GetInfoResponse parser).
        let target_height = zcash_protocol::consensus::BlockHeight::from(
            u32::try_from(info.block_height + 1)?
        );
        let branch = zcash_protocol::consensus::BranchId::for_height(&params, target_height);
        let expected = format!("{:08x}", u32::from(branch));
        eprintln!("WALLET_BRANCH: {:?} ({expected})", branch);
        eprintln!("SERVER_BRANCH: {}", info.consensus_branch_id);
        if info.chain_name != "test" {
            anyhow::bail!("This candidate is restricted to testnet evaluation.");
        }
        if info.consensus_branch_id.to_lowercase().trim_start_matches("0x") != expected {
            anyhow::bail!("Wallet/server branch mismatch; do not send.");
        }
        let json = serde_json::json!({
            "server_uri": server_uri,
            "chain_name": info.chain_name,
            "chain_tip_height": info.block_height,
        });
        println!("{}", serde_json::to_string(&json)?);

        Ok(())
    }
}

#[cfg(test)]
mod veylo_nu7_tests {
    use zcash_protocol::consensus::{BlockHeight, BranchId, NetworkUpgrade, Parameters, TEST_NETWORK, MAIN_NETWORK};
    use zcash_primitives::transaction::TxVersion;
    #[test]
    fn veylo_nu7_activation_and_wire_id() {
        assert_eq!(BranchId::for_height(&TEST_NETWORK, BlockHeight::from(4_465_025)), BranchId::Nu6_3);
        assert_eq!(BranchId::for_height(&TEST_NETWORK, BlockHeight::from(4_465_026)), BranchId::Nu7);
        assert_eq!(BranchId::for_height(&TEST_NETWORK, BlockHeight::from(4_465_331)), BranchId::Nu7);
        assert_eq!(u32::from(BranchId::Nu7), 0x77190ad9);
        assert_eq!(BranchId::try_from(0x77190ad9).unwrap(), BranchId::Nu7);
        assert_eq!(MAIN_NETWORK.activation_height(NetworkUpgrade::Nu7), None);
        assert!(matches!(TxVersion::suggested_for_branch(BranchId::Nu7), TxVersion::V6));
        assert!(TxVersion::V6.valid_in_branch(BranchId::Nu7));
        assert!(!TxVersion::V4.valid_in_branch(BranchId::Nu7));
    }
}
