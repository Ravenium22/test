import { createClient } from "@supabase/supabase-js";
import cors from "cors";
import Decimal from "decimal.js";
import {
  ActionRowBuilder,
  APIInteractionGuildMember,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  Guild,
  GuildMember,
  GuildMemberRoleManager,
  REST,
  Role,
  RoleResolvable,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import "dotenv/config";
import express from "express";
import fs from "fs";
import http from "http";
import { scheduleJob } from "node-schedule";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { v4 } from "uuid";
import { Database } from "./types/supabase";

let projects: string[] = [];

/*
#############################################
#
# SUPABASE STUFF
#
#############################################
*/
const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_KEY!;
const supabase = createClient<Database>(supabaseUrl, supabaseKey);

/*
#############################################
#
# DISCORD STUFF
#
#############################################
*/
const discordBotToken = process.env.DISCORD_BOT_TOKEN;
const channelId = "";
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// Define permissioned roles
const ADMIN_ROLE_IDS = [
  "1230906668066406481",
  "1230195803877019718",
  "1230906465334853785",
  "1234239721165815818",
  "880593522896539649", // TEST ADMIN ROLE FOR TEST DISCORD SERVER 
];

// Helper function to check if user has admin role
function hasAdminRole(member: GuildMember | APIInteractionGuildMember | null) {
  if (
    member &&
    "roles" in member &&
    member.roles instanceof GuildMemberRoleManager
  ) {
    return member.roles.cache.some((role: Role) =>
      ADMIN_ROLE_IDS.includes(role.id)
    );
  }
  return false;
}
export const maskAddress = (address: string) => {
  if (!address || address.length < 6) return address;
  return `${address.slice(0, 2)}...${address.slice(-4)}`;
};
// Excludements for leaderboard
const EXCLUDED_USER_IDS = [
  "649377665496776724", // abarat
  "534027215973646346", // rxx
  "144683637718122496"  // yeshy.smol
];

// New constants for role management
const WHITELIST_ROLE_ID = "1263470313300295751";
const MOOLALIST_ROLE_ID = "1263470568536014870";
const FREE_MINT_ROLE_ID = "1263470790314164325";
const MOOTARD_ROLE_ID = "1281979123534925967";
const BULL_ROLE_ID = "1230207362145452103";
const BEAR_ROLE_ID = "1230207106896892006";

let WHITELIST_MINIMUM = 100; // Initial minimum, can be updated

// New function to get team points
async function getTeamPoints() {
  const [bullasData, berasData] = await Promise.all([
    supabase.rpc("sum_points_for_team", { team_name: "bullas" }),
    supabase.rpc("sum_points_for_team", { team_name: "beras" }),
  ]);

  return {
    bullas: bullasData.data ?? 0,
    beras: berasData.data ?? 0,
  };
}

// New function to get top players
async function getTopPlayers(team: string, limit: number) {
  const { data, error } = await supabase
    .from("users")
    .select("discord_id, address, points")
    .eq("team", team)
    .order("points", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data;
}

// New optimized function to create CSV content
async function createCSV(data: any[], includeDiscordId: boolean = false, guild: Guild) {
  const header = includeDiscordId
    ? "discord_id,address,points,wl_role,ml_role,free_mint_role\n"
    : "address,points,wl_role,ml_role,free_mint_role\n";

  const WL_WINNER_ROLE_ID = "1264963781419597916";
  const ML_WINNER_ROLE_ID = "1267532607491407933";

  // Fetch all members at once
  const memberIds = data.map(user => user.discord_id).filter(Boolean);
  const membersMap = new Map();
  
  try {
    const members = await guild.members.fetch({ user: memberIds });
    members.forEach(member => membersMap.set(member.id, member));
  } catch (error) {
    console.error("Error fetching members:", error);
  }

  const rows = data.map(user => {
    const member = membersMap.get(user.discord_id);
    const hasWL = member?.roles.cache.has(WHITELIST_ROLE_ID) || member?.roles.cache.has(WL_WINNER_ROLE_ID) ? "Y" : "N";
    const hasML = member?.roles.cache.has(MOOLALIST_ROLE_ID) || member?.roles.cache.has(ML_WINNER_ROLE_ID) ? "Y" : "N";
    const hasFreeMint = member?.roles.cache.has(FREE_MINT_ROLE_ID) ? "Y" : "N";

    return includeDiscordId
      ? `${user.discord_id},${user.address},${user.points},${hasWL},${hasML},${hasFreeMint}`
      : `${user.address},${user.points},${hasWL},${hasML},${hasFreeMint}`;
  });

  return header + rows.join("\n");
}

// New function to save CSV file
async function saveCSV(content: string, filename: string) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const tempDir = join(__dirname, "temp");
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir);
  }
  const filePath = join(tempDir, filename);
  fs.writeFileSync(filePath, content);
  return filePath;
}

// Improve the updateRoles function
async function updateRoles(
  guild: Guild,
  teamType: 'winning' | 'losing',
  wlThreshold: number,
  mlThreshold: number,
  freemintThreshold: number
) {
  console.log(`Starting role update process for ${teamType} team...`);
  
  const whitelistRole = guild.roles.cache.get(WHITELIST_ROLE_ID);
  const moolalistRole = guild.roles.cache.get(MOOLALIST_ROLE_ID);
  const freeMintRole = guild.roles.cache.get(FREE_MINT_ROLE_ID);
  const wlWinnerRole = guild.roles.cache.get("1230195803877019718");
  const mlWinnerRole = guild.roles.cache.get("1230906668066406481");

  if (!whitelistRole || !moolalistRole || !freeMintRole || !wlWinnerRole || !mlWinnerRole) {
    console.error("One or more roles not found. Aborting role update.");
    return;
  }

  const teamPoints = await getTeamPoints();
  const winningTeam = teamPoints.bullas > teamPoints.beras ? "bullas" : "beras";
  const targetTeam = teamType === 'winning' ? winningTeam : (winningTeam === "bullas" ? "beras" : "bullas");

  const { data: players, error } = await supabase
    .from("users")
    .select("discord_id, points, team")
    .eq("team", targetTeam);

  if (error) {
    console.error("Error fetching players:", error);
    return;
  }

  console.log(`Updating roles for ${players.length} players in ${targetTeam} team...`);

  for (const player of players) {
    if (player.discord_id) {
      try {
        const member = await guild.members.fetch(player.discord_id);
        if (member) {
          // WL Role Management
          if (player.points >= wlThreshold) {
            if (!member.roles.cache.has(WHITELIST_ROLE_ID) && !member.roles.cache.has(WL_WINNER_ROLE_ID)) {
              await member.roles.add(whitelistRole);
            }
          }

          // ML Role Management
          if (player.points >= mlThreshold) {
            if (!member.roles.cache.has(MOOLALIST_ROLE_ID) && !member.roles.cache.has(ML_WINNER_ROLE_ID)) {
              await member.roles.add(moolalistRole);
            }
          }

          // Free Mint Role Management
          if (player.points >= freemintThreshold) {
            if (!member.roles.cache.has(FREE_MINT_ROLE_ID)) {
              await member.roles.add(freeMintRole);
            }
          }

          console.log(`Updated roles for user: ${player.discord_id}`);
        }
      } catch (error) {
        console.error(`Error updating roles for user ${player.discord_id}:`, error);
      }
    }
  }

  console.log(`Role update process completed for ${teamType} team.`);
}

// */ Improve the cron job scheduling
//   const roleUpdateJob = scheduleJob("0 */6 * * *", async () => {
//   console.log("Running scheduled role update job...");
//   const guild = client.guilds.cache.get("1228994421966766141"); // Replace with your actual guild ID
//   if (guild) {
//     await updateRoles(guild);
//     console.log("Scheduled role update completed");
//   } else {
//     console.error("Guild not found for scheduled role update");
//   }
// });

// Define your commands
const commands = [
  new SlashCommandBuilder()
    .setName("updateroles")
    .setDescription("Manually update roles")
    .addStringOption(option =>
      option.setName('team')
        .setDescription('Team to update roles for')
        .setRequired(true)
        .addChoices(
          { name: 'Winning', value: 'winning' },
          { name: 'Losing', value: 'losing' }
        ))
    .addIntegerOption(option =>
      option.setName('wl_threshold')
        .setDescription('MOOLA threshold for WL role')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('ml_threshold')
        .setDescription('MOOLA threshold for ML role')
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('freemint_threshold')
        .setDescription('MOOLA threshold for Free Mint role')
        .setRequired(true)),
  new SlashCommandBuilder()
    .setName("transfer")
    .setDescription("Transfer points to another user")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The user to transfer points to")
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("The amount of points to transfer")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("wankme")
    .setDescription("Link your Discord account to your address"),
  new SlashCommandBuilder()
    .setName("moola")
    .setDescription("Check your moola balance"),
  new SlashCommandBuilder().setName("team").setDescription("Choose your team"),
  new SlashCommandBuilder()
    .setName("warstatus")
    .setDescription("Check the current war status"),
  new SlashCommandBuilder()
     .setName("updatewallet")
    .setDescription("Update your wallet address"),
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("View the leaderboard")
    .addStringOption(option =>
      option.setName('team')
        .setDescription('Team leaderboard to view')
        .addChoices(
          { name: 'All', value: 'all' },
          { name: 'Bullas', value: 'bullas' },
          { name: 'Beras', value: 'beras' }
        )
        .setRequired(true))
    .addIntegerOption(option =>
      option.setName('page')
        .setDescription('Page number')
        .setMinValue(1)
        .setRequired(false)),
  new SlashCommandBuilder()
    .setName("snapshot")
    .setDescription("Take a snapshot of the current standings"),
  new SlashCommandBuilder()
    .setName("fine")
    .setDescription("Fine a user")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The user to fine")
        .setRequired(true)
    )
    .addIntegerOption((option) =>
      option
        .setName("amount")
        .setDescription("The amount to fine")
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("updatewhitelistminimum")
    .setDescription("Update the whitelist minimum")
    .addIntegerOption((option) =>
      option
        .setName("minimum")
        .setDescription("The new minimum value")
        .setRequired(true)
    ),
];

client.once("ready", async () => {
  console.log("Bot is ready!");

  // Register slash commands
  const rest = new REST({ version: "10" }).setToken(discordBotToken!);

  try {
    console.log("Started refreshing application (/) commands.");

    await rest.put(Routes.applicationCommands(client.user!.id), {
      body: commands,
    });

    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error("Error refreshing application (/) commands:", error);
  }
});

// Add a manual trigger for role updates (for testing)
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;

  if (interaction.commandName === "updateroles") {
    if (!hasAdminRole(interaction.member)) {
      await interaction.reply({
        content: "You don't have permission to use this command.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();
    const guild = interaction.guild;
    
    if (!guild) {
      await interaction.editReply("Failed to update roles: Guild not found.");
      return;
    }

    const team = interaction.options.getString("team", true) as 'winning' | 'losing';
    const wlThreshold = interaction.options.getInteger("wl_threshold", true);
    const mlThreshold = interaction.options.getInteger("ml_threshold", true);
    const freemintThreshold = interaction.options.getInteger("freemint_threshold", true);

    try {
      await updateRoles(guild, team, wlThreshold, mlThreshold, freemintThreshold);
      await interaction.editReply(
        `Roles have been updated for ${team} team with thresholds:\n` +
        `WL: ${wlThreshold}\nML: ${mlThreshold}\nFree Mint: ${freemintThreshold}`
      );
    } catch (error) {
      console.error("Error updating roles:", error);
      await interaction.editReply("An error occurred while updating roles.");
    }
  }

  if (interaction.commandName === "transfer") {
    if (!hasAdminRole(interaction.member)) {
      await interaction.reply({
        content: "You don't have permission to use this command.",
        ephemeral: true,
      });
      return;
    }

    const userId = interaction.user.id;
    const targetUser = interaction.options.getUser("user");
    const amount = interaction.options.get("amount")?.value as number;

    if (!targetUser || !amount) {
      await interaction.reply("Please provide a valid user and amount.");
      return;
    }

    const { data: senderData, error: senderError } = await supabase
      .from("users")
      .select("*")
      .eq("discord_id", userId)
      .single();

    if (senderError || !senderData) {
      console.error("Error fetching sender:", senderError);
      await interaction.reply("An error occurred while fetching the sender.");
      return;
    }

    if (senderData.points < amount) {
      await interaction.reply("Insufficient points to transfer.");
      return;
    }

    const { data: receiverData, error: receiverError } = await supabase
      .from("users")
      .select("*")
      .eq("discord_id", targetUser.id)
      .single();

    if (receiverError) {
      console.error("Error fetching receiver:", receiverError);
      await interaction.reply("An error occurred while fetching the receiver.");
      return;
    }

    if (!receiverData) {
      await interaction.reply("The specified user does not exist.");
      return;
    }

    const senderPoints = new Decimal(senderData.points);
    const receiverPoints = new Decimal(receiverData.points);
    const transferAmount = new Decimal(amount);

    const updatedSenderPoints = senderPoints.minus(transferAmount);
    const updatedReceiverPoints = receiverPoints.plus(transferAmount);

    const { data: senderUpdateData, error: senderUpdateError } = await supabase
      .from("users")
      .update({ points: updatedSenderPoints.toNumber() })
      .eq("discord_id", userId);

    if (senderUpdateError) {
      console.error("Error updating sender points:", senderUpdateError);
      await interaction.reply(
        "An error occurred while updating sender points."
      );
      return;
    }

    const { data: receiverUpdateData, error: receiverUpdateError } =
      await supabase
        .from("users")
        .update({ points: updatedReceiverPoints.toNumber() })
        .eq("discord_id", targetUser.id);

    if (receiverUpdateError) {
      console.error("Error updating receiver points:", receiverUpdateError);
      await interaction.reply(
        "An error occurred while updating receiver points."
      );
      return;
    }

    await interaction.reply(
      `Successfully transferred ${amount} points to <@${targetUser.id}>.`
    );
  }

  if (interaction.commandName === "wankme") {
    const userId = interaction.user.id;
    const uuid = v4();

    const { data: userData } = await supabase
      .from("users")
      .select("*")
      .eq("discord_id", userId)
      .single();

      if (userData) {
        await interaction.reply({
          content: `You have already linked your account. Your linked account: \`${maskAddress(userData.address)}\``,
          ephemeral: true
        });
        return;
      }

    const { data, error } = await supabase
      .from("tokens")
      .insert({ token: uuid, discord_id: userId, used: false })
      .single();

    const embed = new EmbedBuilder()
      .setColor(0x0099ff)
      .setTitle("Some title")
      .setDescription("Some description");

    if (error) {
      console.error("Error inserting token:", error);
      await interaction.reply({
        content: "An error occurred while generating the token.",
        ephemeral: true,
      });
    } else {
      const vercelUrl = `${process.env.VERCEL_URL}/game?token=${uuid}&discord=${userId}`;
      await interaction.reply({
        content: `Hey ${interaction.user.username}, to link your Discord account to your address click this link: \n\n${vercelUrl} `,
        ephemeral: true,
      });
    }
  }
  if (interaction.commandName === "updatewallet") {
    const userId = interaction.user.id;
    const uuid = v4();
  
    const { data: userData } = await supabase
      .from("users")
      .select("*")
      .eq("discord_id", userId)
      .single();
  
    if (!userData) {
      await interaction.reply({
        content: "You need to link your account first. Use /wankme to get started.",
        ephemeral: true,
      });
      return;
    }
  
    const { error } = await supabase
      .from("tokens")
      .insert({ token: uuid, discord_id: userId, used: false })
      .single();
  
    if (error) {
      console.error("Error inserting token:", error);
      await interaction.reply({
        content: "An error occurred while generating the token.",
        ephemeral: true,
      });
    } else {
      const vercelUrl = `${process.env.VERCEL_URL}/update-wallet?token=${uuid}&discord=${userId}`;
      await interaction.reply({
        content: `Hey ${interaction.user.username}, to update your wallet address, click this link:\n\n${vercelUrl}`,
        ephemeral: true,
      });
    }
  }

  if (interaction.commandName === "moola") {
    const userId = interaction.user.id;
    const uuid = v4();

    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("discord_id", userId)
      .single();

    if (error) {
      console.error("Error fetching user:", error);
      await interaction.reply("An error occurred while fetching the user.");
    } else {
      const moolaEmbed = new EmbedBuilder()
        .setColor(0xffd700)
        .setTitle(`${interaction.user.username}'s moola`)
        .setDescription(`You have ${data.points} moola. 🍯`)
        .setThumbnail(interaction.user.displayAvatarURL())
        .setTimestamp();

      await interaction.reply({
        embeds: [moolaEmbed],
      });
    }
  }

  if (interaction.commandName === "team") {
    const userId = interaction.user.id;
    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("*")
      .eq("discord_id", userId)
      .single();
  
    if (userError || !userData) {
      await interaction.reply({
        content: "You need to link your account first. Please use the `/wankme` command to get started.",
        ephemeral: true,
      });
      return;
    }
  
    const member = interaction.member as GuildMember;
    const hasTeamRole = member.roles.cache.has(BULL_ROLE_ID) || member.roles.cache.has(BEAR_ROLE_ID);
  
    // If user has team in database but no role, allow them to rejoin their team
    if (userData.team && !hasTeamRole) {
      const teamRole = userData.team === "bullas" 
        ? interaction.guild?.roles.cache.get(BULL_ROLE_ID)
        : interaction.guild?.roles.cache.get(BEAR_ROLE_ID);
  
      if (teamRole && interaction.guild) {
        await member.roles.add(teamRole);
        if (member.roles.cache.has(MOOTARD_ROLE_ID)) {
          await member.roles.remove(MOOTARD_ROLE_ID);
        }
        await interaction.reply({
          content: `Welcome back! You've been reassigned to the ${userData.team} team.`,
          ephemeral: true,
        });
        return;
      }
    }
  
    // Regular team selection for new users
    if (userData.team && hasTeamRole) {
      await interaction.reply({
        content: `You have already joined the ${userData.team} team. You cannot change your team.`,
        ephemeral: true,
      });
      return;
    }
  
    const embed = new EmbedBuilder()
      .setTitle("Choose Your Team")
      .setDescription("Are you a bulla or a bera? Click the button to choose your team and get the corresponding role.")
      .setColor("#0099ff");
  
    const bullButton = new ButtonBuilder()
      .setCustomId("bullButton")
      .setLabel("🐂 Bullas")
      .setStyle(ButtonStyle.Primary);
  
    const bearButton = new ButtonBuilder()
      .setCustomId("bearButton")
      .setLabel("🐻 Beras")
      .setStyle(ButtonStyle.Primary);
  
    const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(bullButton, bearButton);
  
    await interaction.reply({
      embeds: [embed],
      components: [actionRow as any],
    });
  }

  if (interaction.commandName === "warstatus") {
    try {
      const [bullasData, berasData] = await Promise.all([
        supabase.rpc("sum_points_for_team", { team_name: "bullas" }),
        supabase.rpc("sum_points_for_team", { team_name: "beras" }),
      ]);

      const bullas = bullasData.data ?? 0;
      const beras = berasData.data ?? 0;

      const embed = new EmbedBuilder()
        .setTitle("🏆 Moola War Status")
        .setDescription(`The battle between the Bullas and Beras rages on!`)
        .addFields(
          {
            name: "🐂 Bullas",
            value: `moola (mL): ${bullas}`,
            inline: true,
          },
          {
            name: "🐻 Beras",
            value: `moola (mL): ${beras}`,
            inline: true,
          }
        )
        .setColor("#FF0000");
      // .setTimestamp()
      // .setFooter({
      //   text: "May the best team win!",
      //   // iconURL: "https://i.imgur.com/AfFp7pu.png",
      // });

      await interaction.reply({ embeds: [embed] });
    } catch (error) {
      console.error("Error fetching war status:", error);
      await interaction.reply(
        "An error occurred while fetching the war status."
      );
    }
  }

  if (interaction.commandName === "leaderboard") {
    try {
      const teamOption = interaction.options.getString("team", true);
      const page = interaction.options.getInteger("page") || 1;
      const itemsPerPage = 10;
      const skip = (page - 1) * itemsPerPage;

      // Get user's rank first
      let rankQuery = supabase
        .from("users")
        .select("discord_id, points, team")
        .not("discord_id", "in", `(${EXCLUDED_USER_IDS.join(",")})`)
        .order("points", { ascending: false });

      if (teamOption !== "all") {
        rankQuery = rankQuery.eq("team", teamOption);
      }

      const { data: allUsers } = await rankQuery;
      const userRank = allUsers?.findIndex(user => user.discord_id === interaction.user.id) ?? -1;
      const userData = allUsers?.[userRank];

      // Get paginated leaderboard data
      let query = supabase
        .from("users")
        .select("discord_id, points, team", { count: "exact" })
        .not("discord_id", "in", `(${EXCLUDED_USER_IDS.join(",")})`)
        .order("points", { ascending: false });

      if (teamOption !== "all") {
        query = query.eq("team", teamOption);
      }

      const { data: leaderboardData, count, error } = await query
        .range(skip, skip + itemsPerPage - 1);

      if (error) {
        throw error;
      }

      if (!leaderboardData || leaderboardData.length === 0) {
        await interaction.reply("No users found.");
        return;
      }

      const totalPages = Math.ceil((count || 0) / itemsPerPage);

      const leaderboardEmbed = new EmbedBuilder()
        .setColor(teamOption === "bullas" ? "#22C55E" : teamOption === "beras" ? "#EF4444" : "#FFD700");

      // Add user's rank at the top with username
      if (userRank !== -1 && userData) {
        leaderboardEmbed.addFields({
          name: "Your Rank",
          value: `${userRank + 1}. ${userData.team === "bullas" ? "🐂" : "🐻"} ${interaction.user.username} • ${userData.points.toLocaleString()} mL`,
          inline: false
        });
      }

      // Add Leaderboard section with usernames
      const leaderboardEntries = await Promise.all(
        leaderboardData.map(async (entry, index) => {
          const user = await client.users.fetch(entry.discord_id);
          const position = skip + index + 1;
          return `${position}. ${entry.team === "bullas" ? "🐂" : "🐻"} ${user.username} • ${entry.points.toLocaleString()} mL`;
        })
      );

      leaderboardEmbed.addFields({
        name: "🏆 Leaderboard",
        value: leaderboardEntries.join('\n'),
        inline: false
      });

      leaderboardEmbed.setFooter({ 
        text: `Page ${page}/${totalPages}`
      });

      // Create pagination buttons
      const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`prev_${teamOption}_${page}`)
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page <= 1),
          new ButtonBuilder()
            .setCustomId(`next_${teamOption}_${page}`)
            .setLabel('Next')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(page >= totalPages)
        );

      await interaction.reply({ 
        embeds: [leaderboardEmbed],
        components: [row]
      });
    } catch (error) {
      console.error("Error handling leaderboard command:", error);
      await interaction.reply(
        "An error occurred while processing the leaderboard command."
      );
    }
  }

  if (interaction.commandName === "snapshot") {
    if (!hasAdminRole(interaction.member)) {
      await interaction.reply({
        content: "You don't have permission to use this command.",
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    try {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.editReply("Guild not found.");
        return;
      }

      const teamPoints = await getTeamPoints();
      const winningTeam =
        teamPoints.bullas > teamPoints.beras ? "bullas" : "beras";
      const losingTeam = winningTeam === "bullas" ? "beras" : "bullas";

      const winningTopPlayers = await getTopPlayers(winningTeam, 2000);
      const losingTopPlayers = await getTopPlayers(losingTeam, 700);
      const allPlayers = await getTopPlayers(
        winningTeam,
        Number.MAX_SAFE_INTEGER
      );
      allPlayers.push(
        ...(await getTopPlayers(losingTeam, Number.MAX_SAFE_INTEGER))
      );
      allPlayers.sort((a, b) => b.points - a.points);

      const winningCSV = await createCSV(winningTopPlayers, false, guild);
      const losingCSV = await createCSV(losingTopPlayers, false, guild);
      const allCSV = await createCSV(allPlayers, true, guild);

      const winningFile = await saveCSV(
        winningCSV,
        `top_2000_${winningTeam}.csv`
      );
      const losingFile = await saveCSV(losingCSV, `top_700_${losingTeam}.csv`);
      const allFile = await saveCSV(allCSV, `all_players.csv`);

      await interaction.editReply({
        content: `Here are the snapshot files with role information:`,
        files: [winningFile, losingFile, allFile],
      });

      // Delete temporary files
      fs.unlinkSync(winningFile);
      fs.unlinkSync(losingFile);
      fs.unlinkSync(allFile);
    } catch (error) {
      console.error("Error handling snapshot command:", error);
      await interaction.editReply(
        "An error occurred while processing the snapshot command."
      );
    }
  }

  if (interaction.commandName === "fine") {
    if (!hasAdminRole(interaction.member)) {
      await interaction.reply({
        content: "You don't have permission to use this command.",
        ephemeral: true,
      });
      return;
    }

    const targetUser = interaction.options.getUser("user");
    const amount = interaction.options.get("amount")?.value as number;

    if (!targetUser || !amount || amount <= 0) {
      await interaction.reply(
        "Please provide a valid user and a positive amount."
      );
      return;
    }

    try {
      const { data: userData, error: userError } = await supabase
        .from("users")
        .select("*")
        .eq("discord_id", targetUser.id)
        .single();

      if (userError || !userData) {
        await interaction.reply("User not found or an error occurred.");
        return;
      }

      const currentPoints = new Decimal(userData.points);
      const fineAmount = new Decimal(amount);

      if (currentPoints.lessThan(fineAmount)) {
        await interaction.reply(
          "The user doesn't have enough points for this fine."
        );
        return;
      }

      const updatedPoints = currentPoints.minus(fineAmount);

      const { error: updateError } = await supabase
        .from("users")
        .update({ points: updatedPoints.toNumber() })
        .eq("discord_id", targetUser.id);

      if (updateError) {
        throw new Error("Failed to update user points");
      }

      await interaction.reply(
        `Successfully fined <@${targetUser.id}> ${amount} points. Their new balance is ${updatedPoints} points.`
      );
    } catch (error) {
      console.error("Error handling fine command:", error);
      await interaction.reply(
        "An error occurred while processing the fine command."
      );
    }
  }

  if (interaction.commandName === "updatewhitelistminimum") {
    if (!hasAdminRole(interaction.member)) {
      await interaction.reply({
        content: "You don't have permission to use this command.",
        ephemeral: true,
      });
      return;
    }

    const newMinimum = interaction.options.get("minimum")?.value as number;
    if (!newMinimum || newMinimum <= 0) {
      await interaction.reply(
        "Please provide a valid positive integer for the new minimum."
      );
      return;
    }

    WHITELIST_MINIMUM = newMinimum;
    await interaction.reply(
      `Whitelist minimum updated to ${WHITELIST_MINIMUM} MOOLA.`
    );

    // Trigger an immediate role update
    const guild = interaction.guild;
    if (guild) {
      await updateRoles(guild);
      await interaction.followUp(
        "Roles have been updated based on the new minimum."
      );
    }
  }
});

// Add this function to handle new member joins
client.on("guildMemberAdd", async (member) => {
  const mootardRole = member.guild.roles.cache.get(MOOTARD_ROLE_ID);
  if (mootardRole) {
    await member.roles.add(mootardRole);
    console.log(`Added Mootard role to new member: ${member.user.tag}`);
  }
});

// Modify the team selection logic in the button interaction handler
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;
  if (!interaction.member || !interaction.guild) return;

  const BULL_ROLE_ID = "1230207362145452103";
  const BEAR_ROLE_ID = "1230207106896892006";
  const member = interaction.member as GuildMember;
  const roles = member.roles;

  const bullRole = interaction.guild.roles.cache.get(BULL_ROLE_ID);
  const bearRole = interaction.guild.roles.cache.get(BEAR_ROLE_ID);
  const mootardRole = interaction.guild.roles.cache.get(MOOTARD_ROLE_ID);

  if (bearRole || !bullRole || !mootardRole) return;

  async function removeRolesAndAddTeam(teamRole: Role, teamName: string) {
    // Remove the Mootard role
    if (roles.cache.has(MOOTARD_ROLE_ID)) {
      await roles.remove(mootardRole as RoleResolvable);
    }

    // Remove the opposite team role if present
    const oppositeRoleId =
      teamRole.id === BULL_ROLE_ID ? BEAR_ROLE_ID : BULL_ROLE_ID;
    if (roles.cache.has(oppositeRoleId)) {
      await roles.remove(oppositeRoleId === BULL_ROLE_ID ? bullRole : bearRole);
    }

    // Add the new team role
    await roles.add(teamRole);

    // Update the user's team in the database
    const { error } = await supabase
      .from("users")
      .update({ team: teamName })
      .eq("discord_id", interaction.user.id);

    if (error) {
      console.error(`Error updating user team to ${teamName}:`, error);
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: `An error occurred while joining the ${teamName} team. Please try again.`,
          ephemeral: true,
        });
      }
      return false;
    }

    return true;
  }

  if (interaction.customId === "bullButton") {
    if (await removeRolesAndAddTeam(bullRole, "bullas")) {
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: "You have joined the Bullas team!",
          ephemeral: true,
        });
      }
    }
  } else if (interaction.customId === "bearButton") {
    if (await removeRolesAndAddTeam(bearRole, "beras")) {
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: "You have joined the Beras team!",
          ephemeral: true,
        });
      }
    }
  }

  // Delete the original message
  if (interaction.message) {
    await interaction.message.delete();
  }
});

// Handle button interactions
client.on("interactionCreate", async (interaction) => {
  // Replace 'BULL_ROLE_ID' and 'BEAR_ROLE_ID' with the actual role IDs
  const BULL_ROLE_ID = "1230207362145452103";
  const BEAR_ROLE_ID = "1230207106896892006";
  const member = interaction.member;

  if (!interaction.isButton()) return;
  if (!member || !interaction.guild) return;

  const bullRole = interaction.guild.roles.cache.get(BULL_ROLE_ID);
  const bearRole = interaction.guild.roles.cache.get(BEAR_ROLE_ID);

  if (!bearRole || !bullRole) return;

  const roles = member.roles as GuildMemberRoleManager;

  if (interaction.customId === "bullButton") {
    // Remove the "Bear" role if the user has it
    if (roles.cache.has(BEAR_ROLE_ID)) {
      await roles.remove(bearRole);
    }

    // Add the "Bull" role to the user
    await roles.add(bullRole);

    const { data, error } = await supabase
      .from("users")
      .update({ team: "bullas" })
      .eq("discord_id", interaction.user.id);

    if (error) {
      console.error("Error updating user team:", error);
      await interaction.reply({
        content:
          "An error occurred while joining the Bullas team. Please try again.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: "You have joined the Bullas team!",
      ephemeral: true,
    });

    // Delete the original message
    await interaction.message.delete();
  } else if (interaction.customId === "bearButton") {
    // Remove the "Bull" role if the user has it
    if (roles.cache.has(BULL_ROLE_ID)) {
      await roles.remove(bullRole);
    }

    // Add the "Bear" role to the user
    await roles.add(bearRole);

    const { data, error } = await supabase
      .from("users")
      .update({ team: "beras" })
      .eq("discord_id", interaction.user.id);

    if (error) {
      console.error("Error updating user team:", error);
      await interaction.reply({
        content:
          "An error occurred while joining the Beras team. Please try again.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: "You have joined the Beras team!",
      ephemeral: true,
    });

    // Delete the original message
    await interaction.message.delete();
  }
});
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const [action, teamOption, currentPage] = interaction.customId.split('_');
  if (action !== 'prev' && action !== 'next') return;

  // Only allow the user who ran the command to use the buttons
  if (interaction.message.interaction?.user.id !== interaction.user.id) {
    await interaction.reply({
      content: 'Only the user who ran this command can use these buttons.',
      ephemeral: true
    });
    return;
  }

  const newPage = action === 'next' 
    ? parseInt(currentPage) + 1 
    : parseInt(currentPage) - 1;

  await interaction.deferUpdate();

  try {
    const itemsPerPage = 10;
    const skip = (newPage - 1) * itemsPerPage;

    // Get user's rank first
    let rankQuery = supabase
      .from("users")
      .select("discord_id, points, team")
      .not("discord_id", "in", `(${EXCLUDED_USER_IDS.join(",")})`)
      .order("points", { ascending: false });

    if (teamOption !== "all") {
      rankQuery = rankQuery.eq("team", teamOption);
    }

    const { data: allUsers } = await rankQuery;
    const userRank = allUsers?.findIndex(user => user.discord_id === interaction.user.id) ?? -1;
    const userData = allUsers?.[userRank];

    // Get paginated leaderboard data
    let query = supabase
      .from("users")
      .select("discord_id, points, team", { count: "exact" })
      .not("discord_id", "in", `(${EXCLUDED_USER_IDS.join(",")})`)
      .order("points", { ascending: false });

    if (teamOption !== "all") {
      query = query.eq("team", teamOption);
    }

    const { data: leaderboardData, count, error } = await query
      .range(skip, skip + itemsPerPage - 1);

    if (error) {
      throw error;
    }

    const totalPages = Math.ceil((count || 0) / itemsPerPage);

    const leaderboardEmbed = new EmbedBuilder()
      .setColor(teamOption === "bullas" ? "#22C55E" : teamOption === "beras" ? "#EF4444" : "#FFD700");

    // Add user's rank at the top with username
    if (userRank !== -1 && userData) {
      leaderboardEmbed.addFields({
        name: "Your Rank",
        value: `${userRank + 1}. ${userData.team === "bullas" ? "🐂" : "🐻"} ${interaction.user.username} • ${userData.points.toLocaleString()} mL`,
        inline: false
      });
    }

    // Add Leaderboard section with usernames
    const leaderboardEntries = await Promise.all(
      leaderboardData.map(async (entry, index) => {
        const user = await client.users.fetch(entry.discord_id);
        const position = skip + index + 1;
        return `${position}. ${entry.team === "bullas" ? "🐂" : "🐻"} ${user.username} • ${entry.points.toLocaleString()} mL`;
      })
    );

    leaderboardEmbed.addFields({
      name: "🏆 Leaderboard",
      value: leaderboardEntries.join('\n'),
      inline: false
    });

    leaderboardEmbed.setFooter({ 
      text: `Page ${newPage}/${totalPages}`
    });

    // Create pagination buttons
    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`prev_${teamOption}_${newPage}`)
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(newPage <= 1),
        new ButtonBuilder()
          .setCustomId(`next_${teamOption}_${newPage}`)
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(newPage >= totalPages)
      );

    await interaction.editReply({
      embeds: [leaderboardEmbed],
      components: [row]
    });
  } catch (error) {
    console.error("Error handling leaderboard pagination:", error);
    await interaction.editReply({
      content: "An error occurred while updating the leaderboard.",
      components: []
    });
  }
});
client.login(discordBotToken);

/*
#############################################
#
# REST SERVER
#
#############################################
*/
const app = express();
app.use(express.json());
app.use(cors());

const server = http.createServer(app);

const PORT = process.env.PORT || 3003;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
