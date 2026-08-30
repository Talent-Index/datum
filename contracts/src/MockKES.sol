// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * MockKES — a KES-pegged test token, 2 decimals so 1 unit = 1 cent.
 *
 * Stands in for whatever the production settlement instrument turns out to
 * be: a regulated KES stablecoin, or a token mirroring a segregated bank
 * escrow account. The escrow contract holds this, never a volatile asset.
 */
contract MockKES {
    string public constant name = "Test Shilling";
    string public constant symbol = "tKES";
    uint8 public constant decimals = 2;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    /// Open mint — this is a test token for a testnet demo.
    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient balance");
        require(allowance[from][msg.sender] >= amount, "insufficient allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
